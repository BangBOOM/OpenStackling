import { Quaternion, Vector3 } from 'three';
import type { RobotConfig } from './config';

export type MountShape = {
  kind: 'box' | 'cylinder' | 'sphere';
  size: [number, number, number];
  position: Vector3;
  rotation: Quaternion;
};

// Neutral housing layout is shared by fixed and articulated humanoids.
export function humanoidLayout(config: RobotConfig) {
  const column = config.mount.column;
  const center = new Vector3(column.x, 0, column.z);
  const shoulder = new Vector3(2 * column.x - config.base[0], config.base[1], config.base[2]);
  const head = new Vector3(column.x, config.mount.neck.top + 0.09, column.z + 0.045);
  const shoulders = [new Vector3(...(config.base as [number, number, number])), shoulder].map(
    (outer) => ({
      inner: new Vector3(
        column.x + Math.sign(outer.x - column.x) * column.width * 0.35,
        outer.y,
        column.z,
      ),
      outer: outer.clone(),
    }),
  );
  return { center, shoulder, shoulders, head };
}

// The housing and optical mount share this transform with rendered sensor calibration.
export const HEAD_SIZE: [number, number, number] = [0.215, 0.18, 0.145];
export const HEAD_TILT = Math.PI / 12;
export function headMount(config: RobotConfig, pitch: number) {
  const { head } = humanoidLayout(config);
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), HEAD_TILT);
  const opticalRotation = new Quaternion().setFromAxisAngle(
    new Vector3(1, 0, 0),
    (pitch * Math.PI) / 180,
  );
  const window = new Vector3(0, 0.028, 0.082).applyQuaternion(rotation).add(head);
  const lens = new Vector3(0, 0, 0.006).applyQuaternion(opticalRotation).add(window);
  return { head, rotation, window, lens, opticalRotation };
}

// Shared fixed support envelopes keep the visible pedestal aligned with its colliders.
export function pedestalPost(config: RobotConfig): MountShape[] {
  const { column, topPlate: plate } = config.mount;
  const bottom = plate.y + plate.thickness / 2;
  const top = column.bottom - 0.065;
  const sleeve = (top - bottom) * 0.38;
  return [
    {
      kind: 'box',
      size: [0.17, sleeve, 0.17],
      position: new Vector3(column.x, bottom + sleeve / 2, column.z),
      rotation: new Quaternion(),
    },
    {
      kind: 'box',
      size: [0.12, top - bottom - sleeve, 0.12],
      position: new Vector3(column.x, (top + bottom + sleeve) / 2, column.z),
      rotation: new Quaternion(),
    },
  ];
}

export function mountShapes(config: RobotConfig): MountShape[] {
  const shapes: MountShape[] = [...pedestalPost(config)];
  const add = (
    kind: MountShape['kind'],
    size: MountShape['size'],
    position: Vector3,
    rotation = new Quaternion(),
  ) => shapes.push({ kind, size, position, rotation });
  const { column, topPlate: plate, neck } = config.mount;
  const height = column.top - column.bottom;
  for (const [low, high, width, depth] of [
    [0, 0.2, 0.58, 0.72],
    [0.2, 0.55, 0.84, 0.94],
    [0.55, 1, 1, 1],
  ])
    add(
      'box',
      [column.width * width, height * (high - low), column.depth * depth],
      new Vector3(column.x, column.bottom + (height * (low + high)) / 2, column.z),
    );
  add('box', [plate.width, plate.thickness, plate.depth], new Vector3(plate.x, plate.y, plate.z));
  add(
    'cylinder',
    [neck.radius, neck.top - neck.bottom, neck.radius],
    new Vector3(neck.x, (neck.top + neck.bottom) / 2, neck.z),
  );
  const { head, shoulders } = humanoidLayout(config);
  add('box', HEAD_SIZE, head, new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), HEAD_TILT));
  for (const { inner, outer } of shoulders) {
    const end = inner.clone().lerp(outer, 0.45);
    add(
      'box',
      [inner.distanceTo(end), 0.045, 0.045],
      inner.clone().add(end).multiplyScalar(0.5),
      new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), end.sub(inner).normalize()),
    );
  }
  return shapes;
}

export function outsideMount(point: Vector3, shapes: MountShape[], margin: number) {
  return shapes.every((shape) => {
    const p = point.clone().sub(shape.position).applyQuaternion(shape.rotation.clone().invert());
    const [x, y, z] = shape.size;
    if (shape.kind === 'sphere') return p.length() >= x + margin;
    if (shape.kind === 'cylinder')
      return Math.abs(p.y) >= y / 2 + margin || Math.hypot(p.x, p.z) >= x + margin;
    return (
      Math.abs(p.x) >= x / 2 + margin ||
      Math.abs(p.y) >= y / 2 + margin ||
      Math.abs(p.z) >= z / 2 + margin
    );
  });
}
