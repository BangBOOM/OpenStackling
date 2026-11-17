import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { RobotConfig } from '../../../simulation/world/config';
import { linkCollider, wristRadii } from '../../../simulation/world/geometry';
import {
  humanoidLayout,
  pedestalPost,
  headMount,
  HEAD_SIZE,
} from '../../../simulation/world/mount';
import type { MaterialSlot } from './theme';

export type RobotMesh = (
  geometry: THREE.BufferGeometry,
  slot: MaterialSlot,
  x: number,
  y: number,
  z: number,
) => THREE.Mesh;
type Section = [height: number, width: number, depth: number];

// Elliptical sections give the armor continuous curvature without external model assets.
function shell(sections: Section[], start = 0, sweep = Math.PI * 2, exponent = 1) {
  const curve = new THREE.CatmullRomCurve3(sections.map(([y, x, z]) => new THREE.Vector3(x, y, z)));
  const rings = curve.getPoints(40),
    segments = 48;
  const positions: number[] = [],
    indices: number[] = [];
  for (const ring of rings)
    for (let j = 0; j <= segments; j++) {
      const a = start + (j / segments) * sweep;
      const c = Math.cos(a),
        s = Math.sin(a);
      positions.push(
        ring.x * Math.sign(c) * Math.abs(c) ** exponent,
        ring.y,
        ring.z * Math.sign(s) * Math.abs(s) ** exponent,
      );
    }
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j,
        b = a + segments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  // Duplicate the rims so the closed end faces retain flat normals.
  for (const end of [0, rings.length - 1]) {
    const ring = rings[end];
    const center = positions.length / 3;
    positions.push(0, ring.y, 0);
    const rim = positions.length / 3;
    for (let j = 0; j <= segments; j++) {
      const offset = (end * (segments + 1) + j) * 3;
      positions.push(...positions.slice(offset, offset + 3));
    }
    for (let j = 0; j < segments; j++)
      indices.push(center, rim + j + (end === 0 ? 0 : 1), rim + j + (end === 0 ? 1 : 0));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// Tessellate the panel before projecting it onto the same profile as the torso.
function fittedPanel(
  shape: THREE.Shape | THREE.Shape[],
  sx: number,
  sy: number,
  y: number,
  sections: Section[],
  offset: number,
  x = 0,
) {
  const source = new THREE.ShapeGeometry(shape, 32).scale(sx, sy, 1).translate(x, y, 0);
  const flat = source.toNonIndexed();
  const positions = flat.getAttribute('position');
  const rings = new THREE.CatmullRomCurve3(
    sections.map(([y, x, z]) => new THREE.Vector3(x, y, z)),
  ).getPoints(200);
  const vertices: number[] = [];
  const surface = (x: number, y: number) => {
    let i = 1;
    while (i < rings.length - 1 && rings[i].y < y) i++;
    const a = rings[i - 1],
      b = rings[i];
    const t = (y - a.y) / (b.y - a.y);
    const width = THREE.MathUtils.lerp(a.x, b.x, t);
    const depth = THREE.MathUtils.lerp(a.z, b.z, t);
    return depth * (1 - (Math.abs(x) / width) ** (2 / 0.68)) ** (0.68 / 2) + offset;
  };
  const normals: number[] = [];
  const project = (p: THREE.Vector3) => {
    vertices.push(p.x, p.y, surface(p.x, p.y));
    const e = 0.001;
    const normal = new THREE.Vector3(
      -(surface(p.x + e, p.y) - surface(p.x - e, p.y)) / (2 * e),
      -(surface(p.x, p.y + e) - surface(p.x, p.y - e)) / (2 * e),
      1,
    ).normalize();
    normals.push(normal.x, normal.y, normal.z);
  };
  const triangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    if (Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) < 0.01) {
      project(a);
      project(b);
      project(c);
      return;
    }
    const ab = a.clone().lerp(b, 0.5),
      bc = b.clone().lerp(c, 0.5),
      ca = c.clone().lerp(a, 0.5);
    triangle(a, ab, ca);
    triangle(ab, b, bc);
    triangle(ca, bc, c);
    triangle(ab, bc, ca);
  };
  for (let i = 0; i < positions.count; i += 3)
    triangle(
      ...([i, i + 1, i + 2].map((j) => new THREE.Vector3().fromBufferAttribute(positions, j)) as [
        THREE.Vector3,
        THREE.Vector3,
        THREE.Vector3,
      ]),
    );
  source.dispose();
  flat.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  const smooth = mergeVertices(geometry);
  geometry.dispose();
  return smooth;
}

export function humanoidLink(config: RobotConfig, index: number, mesh: RobotMesh) {
  const root = new THREE.Group();
  const part = (geometry: THREE.BufferGeometry, slot: MaterialSlot) => {
    const object = mesh(geometry, slot, 0, 0, 0);
    root.add(object);
    return object;
  };
  const length = config.links[index];
  const wrist = wristRadii(config);
  if (index === 0) {
    part(new THREE.SphereGeometry(0.037, 32, 24), 'shell');
  } else if (index === 1 || index === 2) {
    const upper = index === 1,
      radius = upper ? config.visual.jointRadius : 0.046;
    part(new THREE.SphereGeometry(radius, 32, 24).scale(1, 1, 0.78), 'shell');
    for (const sign of [-1, 1]) {
      part(
        new THREE.CylinderGeometry(radius * 0.93, radius * 0.93, 0.003, 40)
          .rotateX(Math.PI / 2)
          .translate(0, 0, sign * radius * 0.64),
        'arm',
      );
      part(
        new THREE.SphereGeometry(radius * 0.88, 32, 24)
          .scale(1, 1, 0.15)
          .translate(0, 0, sign * radius * 0.72),
        'shell',
      );
    }
    part(
      shell([
        [0.012, 0.038, 0.035],
        [length * 0.18, upper ? 0.055 : 0.044, upper ? 0.049 : 0.041],
        [length * 0.48, upper ? 0.047 : 0.042, 0.039],
        [length * 0.8, 0.039, 0.035],
        [length - (upper ? 0.012 : 0.002), 0.032, 0.031],
      ]).rotateZ(-Math.PI / 2),
      'shell',
    );
    part(
      new THREE.CylinderGeometry(upper ? 0.0465 : 0.0415, upper ? 0.0465 : 0.0415, 0.002, 40)
        .scale(1, 1, 0.86)
        .rotateZ(-Math.PI / 2)
        .translate(length * 0.52, 0, 0),
      'arm',
    );
    if (!upper) {
      // The axial core overlaps both housings; only the narrow seal remains exposed.
      part(
        new THREE.CylinderGeometry(0.027, 0.027, 0.03, 40)
          .rotateZ(-Math.PI / 2)
          .translate(length - 0.005, 0, 0),
        'metal',
      );
      part(
        new THREE.CylinderGeometry(0.031, 0.031, 0.003, 40)
          .rotateZ(-Math.PI / 2)
          .translate(length - 0.0005, 0, 0),
        'mechanism',
      );
    }
    for (const sign of [-1, 1]) {
      part(
        new THREE.CylinderGeometry(radius * 0.26, radius * 0.26, 0.002, 32)
          .rotateX(Math.PI / 2)
          .translate(0, 0, sign * radius * 0.865),
        'arm',
      );
      for (let i = 0; i < 3; i++) {
        const angle = (i * Math.PI * 2) / 3;
        part(
          new THREE.CylinderGeometry(0.0018, 0.0018, 0.0015, 6)
            .rotateX(Math.PI / 2)
            .translate(
              Math.cos(angle) * radius * 0.56,
              Math.sin(angle) * radius * 0.56,
              sign * radius * 0.838,
            ),
          'mechanism',
        );
      }
    }
    if (upper)
      for (const sign of [-1, 1])
        part(
          new RoundedBoxGeometry(0.018, 0.007, 0.004, 3, 0.003)
            .rotateZ(sign * 0.4)
            .translate(0.059, sign * 0.036, 0.041),
          'pads',
        );
    const cable = new THREE.CatmullRomCurve3([
      new THREE.Vector3(length * 0.18, 0, -0.05),
      new THREE.Vector3(length * 0.45, 0, -0.061),
      new THREE.Vector3(length * 0.8, 0, -0.051),
      new THREE.Vector3(length - 0.02, 0, -0.033),
    ]);
    // Both cable ends enter the housing instead of stopping above its surface.
    cable.points[0].z = upper ? -0.046 : -0.038;
    cable.points[cable.points.length - 1].z = -0.028;
    part(new THREE.TubeGeometry(cable, 24, 0.0035, 8, false), 'pads');
    for (const t of [0.02, 0.98]) {
      const gland = part(new THREE.CylinderGeometry(0.0055, 0.0055, 0.009, 16), 'mechanism');
      gland.position.copy(cable.getPoint(t));
      gland.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), cable.getTangent(t));
    }
  } else if (index === 3) {
    part(
      new THREE.CylinderGeometry(wrist.roll - 0.002, wrist.roll, length, 32)
        .rotateZ(-Math.PI / 2)
        .translate(length / 2, 0, 0),
      'shell',
    );
    part(
      new THREE.CylinderGeometry(wrist.roll - 0.001, wrist.roll - 0.001, 0.002, 32)
        .rotateZ(-Math.PI / 2)
        .translate(length * 0.65, 0, 0),
      'arm',
    );
  } else if (index === 4) {
    part(new THREE.SphereGeometry(wrist.pitch, 32, 24), 'shell');
    part(
      new THREE.CylinderGeometry(wrist.pitch - 0.006, wrist.pitch - 0.004, length, 32)
        .rotateZ(-Math.PI / 2)
        .translate(length / 2, 0, 0),
      'shell',
    );
    for (const sign of [-1, 1])
      part(
        new THREE.CylinderGeometry(0.007, 0.007, 0.002, 24)
          .rotateX(Math.PI / 2)
          .translate(0, 0, sign * 0.025),
        'accent',
      );
  } else {
    part(new THREE.CylinderGeometry(0.0258, 0.0258, 0.003, 32).rotateZ(-Math.PI / 2), 'mechanism');
    part(
      new THREE.CylinderGeometry(0.025, 0.026, length, 32)
        .rotateZ(-Math.PI / 2)
        .translate(length / 2, 0, 0),
      'shell',
    );
    const palm = linkCollider(config, 5);
    part(new RoundedBoxGeometry(...palm.size, 5, 0.009).translate(palm.x, 0, 0), 'shell');
    part(
      new RoundedBoxGeometry(0.003, 0.02, config.gap[1] + 0.008, 3, 0.001).translate(
        length + palm.size[0],
        0,
        0,
      ),
      'mechanism',
    );
  }
  return root;
}

export function humanoidFinger(config: RobotConfig, sign: number, mesh: RobotMesh) {
  const root = new THREE.Group(),
    length = config.fingerLength;
  const part = (geometry: THREE.BufferGeometry, slot: MaterialSlot) => {
    const object = mesh(geometry, slot, 0, 0, 0);
    root.add(object);
    return object;
  };
  part(new RoundedBoxGeometry(length, config.fingerDepth, config.fingerWidth, 4, 0.001), 'pads');
  part(
    new RoundedBoxGeometry(length * 0.78, config.fingerDepth * 0.9, 0.002, 3, 0.0008).translate(
      -length * 0.1,
      0,
      sign * (config.fingerWidth / 2 + 0.0006),
    ),
    'shell',
  );
  part(
    new RoundedBoxGeometry(
      0.012,
      config.fingerDepth + 0.006,
      config.fingerWidth + 0.004,
      3,
      0.002,
    ).translate(-length / 2 - 0.003, 0, sign * 0.002),
    'shell',
  );
  return root;
}

export function humanoidBody(config: RobotConfig, mesh: RobotMesh, headPitch: number) {
  const root = new THREE.Group();
  const upper = new THREE.Group();
  upper.name = 'moving-torso';
  let parent = root;
  root.add(upper);
  const { center, shoulders } = humanoidLayout(config);
  const column = config.mount.column,
    top = column.top,
    bottom = column.bottom;
  const height = top - bottom,
    width = column.width / 2,
    depth = column.depth / 2;
  const x = center.x,
    z = center.z;
  const part = (geometry: THREE.BufferGeometry, slot: MaterialSlot, px = x, py = 0, pz = z) => {
    const object = mesh(geometry, slot, px, py, pz);
    parent.add(object);
    return object;
  };
  const plate = config.mount.topPlate;
  part(
    new RoundedBoxGeometry(plate.width, plate.thickness, plate.depth, 6, 0.022),
    'plate',
    plate.x,
    plate.y,
    plate.z,
  );
  const posts = pedestalPost(config);
  posts.forEach((post, i) =>
    part(
      new RoundedBoxGeometry(...post.size, 4, i === 0 ? 0.018 : 0.005),
      i === 0 ? 'shell' : 'plate',
      post.position.x,
      post.position.y,
      post.position.z,
    ),
  );
  const sleeve = posts[0],
    post = posts[1];
  part(
    new RoundedBoxGeometry(0.172, 0.006, 0.172, 3, 0.015),
    'arm',
    x,
    sleeve.position.y + sleeve.size[1] / 2 - 0.003,
    z,
  );
  for (const offset of [-0.04, 0, 0.04])
    for (const side of [-1, 1])
      part(
        new THREE.BoxGeometry(0.003, post.size[1], 0.002),
        'arm',
        x + offset,
        post.position.y,
        z + side * 0.061,
      );
  const bodySections: Section[] = [
    [bottom, width * 0.3, depth * 0.3],
    [bottom + height * 0.06, width * 0.6, depth * 0.72],
    [bottom + height * 0.25, width * 0.84, depth * 0.96],
    [bottom + height * 0.6, width, depth],
    [top - 0.025, width, depth],
    [top + 0.008, width * 0.82, depth * 0.8],
    [top + 0.009, 0.001, 0.001],
  ];
  {
    part(new THREE.CylinderGeometry(0.035, 0.035, 0.07, 32), 'metal', x, bottom - 0.045, z);
    part(new THREE.CylinderGeometry(0.075, 0.075, 0.045, 40), 'mechanism', x, bottom, z);
    parent = upper;
    part(new THREE.SphereGeometry(0.077, 32, 24).scale(1, 0.65, 1), 'metal', x, bottom + 0.01, z);
  }
  part(shell(bodySections, 0, Math.PI * 2, 0.68), 'shell');
  const panel = new THREE.Shape();
  panel.moveTo(-0.217, 0.235);
  panel.lineTo(0.217, 0.235);
  panel.bezierCurveTo(0.211, 0.09, 0.19, -0.1, 0.125, -0.145);
  panel.bezierCurveTo(0.065, -0.175, -0.065, -0.175, -0.125, -0.145);
  panel.bezierCurveTo(-0.19, -0.1, -0.211, 0.09, -0.217, 0.235);
  const sx = column.width / 0.6,
    sy = height / 0.65;
  part(fittedPanel(panel, sx, sy, top - 0.235 * sy, bodySections, 0.0015), 'arm');
  part(fittedPanel(panel, sx * 0.94, sy * 0.95, top - 0.235 * sy, bodySections, 0.0022), 'shell');
  for (const { inner, outer } of shoulders) {
    const connection = part(
      new THREE.CylinderGeometry(0.03, 0.033, inner.distanceTo(outer), 32),
      'shell',
      (inner.x + outer.x) / 2,
      (inner.y + outer.y) / 2,
      (inner.z + outer.z) / 2,
    );
    connection.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      outer.clone().sub(inner).normalize(),
    );
  }
  part(
    new THREE.CylinderGeometry(
      config.mount.neck.radius,
      config.mount.neck.radius,
      config.mount.neck.top - config.mount.neck.bottom,
      32,
    ),
    'shell',
    x,
    (config.mount.neck.top + config.mount.neck.bottom) / 2,
    z,
  );
  const optics = headMount(config, headPitch);
  const housing = part(
    new RoundedBoxGeometry(...HEAD_SIZE, 8, 0.042),
    'shell',
    optics.head.x,
    optics.head.y,
    optics.head.z,
  );
  housing.quaternion.copy(optics.rotation);
  const opticalPart = (geometry: THREE.BufferGeometry, slot: MaterialSlot, offset = 0) => {
    const position = new THREE.Vector3(0, 0, offset)
      .applyQuaternion(optics.opticalRotation)
      .add(optics.window);
    const object = part(geometry, slot, position.x, position.y, position.z);
    object.quaternion.copy(optics.opticalRotation);
    return object;
  };
  opticalPart(
    new THREE.CapsuleGeometry(0.017, 0.078, 8, 32).rotateZ(Math.PI / 2).scale(1, 1, 0.25),
    'arm',
    -0.003,
  );
  opticalPart(
    new THREE.CapsuleGeometry(0.012, 0.077, 8, 32).rotateZ(Math.PI / 2).scale(1, 1, 0.3),
    'mechanism',
  );
  opticalPart(
    new THREE.CapsuleGeometry(0.009, 0.075, 8, 32).rotateZ(Math.PI / 2).scale(1, 1, 0.2),
    'visor',
    0.002,
  );
  for (const offset of [-0.023, 0, 0.023]) {
    const lens = opticalPart(
      new THREE.TorusGeometry(offset === 0 ? 0.0045 : 0.0027, 0.0006, 8, 24).translate(
        offset,
        0,
        0,
      ),
      'metal',
      0.004,
    );
    if (offset === 0) lens.name = 'head-camera-lens';
  }
  return root;
}

export function robotReflections() {
  const width = 256,
    height = 128,
    data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = x / width,
        v = y / height;
      const sky = 0.13 + 0.35 * Math.sin(v * Math.PI);
      const softbox =
        (u > 0.12 && u < 0.2 && v > 0.25 && v < 0.76) ||
        (u > 0.65 && u < 0.69 && v > 0.31 && v < 0.68);
      const value = softbox ? 2.8 : sky;
      const i = (y * width + x) * 4;
      data[i] = value;
      data[i + 1] = value * 0.98;
      data[i + 2] = value * 0.94;
      data[i + 3] = 1;
    }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}
