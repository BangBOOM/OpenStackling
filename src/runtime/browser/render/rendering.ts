import { HEAD_CAMERA_DEFAULTS } from '../../../simulation/sensors/config';
import { tableFrame } from '../../../simulation/world/geometry';
import { OBJECT_COLORS } from '../../../simulation/world/objects';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { WorldView } from '../../../simulation/world/view';
import { humanoidBody, humanoidLink, humanoidFinger, robotReflections } from './humanoid';
import { themes } from './themes';
import { validateTheme, type ThemeId } from '../../theme-catalog';
import type { MaterialSlot, SceneLayout, ThemeInstance } from './theme';
export class WorldScene {
  readonly scene = new THREE.Scene();
  readonly baseAnchor = new THREE.Object3D();
  readonly armAnchors = [this.baseAnchor];
  readonly robotMeshes: THREE.Group[];
  readonly pickables: THREE.Object3D[] = [];
  private fingers: THREE.Group[];
  private blocks: THREE.Mesh[];
  private reflections?: THREE.DataTexture;
  visualRevision = 0;
  private theme: ThemeInstance;
  private layout: SceneLayout;
  private geometries = new Set<THREE.BufferGeometry>();
  private bindings: { object: THREE.Mesh; slot: MaterialSlot | number }[] = [];
  private hemisphere = new THREE.HemisphereLight();
  private sun = new THREE.DirectionalLight('#fff2d2', 4);
  private shadows = new Map<
    THREE.WebGLRenderer,
    { shadow: THREE.DirectionalLightShadow; tick: number; revision: number }
  >();
  constructor(
    readonly sim: WorldView,
    public themeId: ThemeId = 'island',
    readonly headPitch = HEAD_CAMERA_DEFAULTS.pitch,
  ) {
    const scene = this.scene,
      TABLE_TOP = sim.config.environment.tableTop,
      tableSize = sim.config.environment.tableSize,
      depth = sim.config.environment.tableDepth;
    const robot = sim.config.environment.robot;
    this.layout = Object.freeze({
      tableTop: TABLE_TOP,
      tableSize,
      tableDepth: depth,
      tableThickness: sim.config.environment.tableThickness,
      blockSize: sim.blockSize,
      blockCount: sim.blockCount,
      objects: Object.freeze(sim.objects.map((o) => Object.freeze(structuredClone(o)))),
      robot: Object.freeze({
        base: Object.freeze([...robot.base]),
        links: Object.freeze([...robot.links]),
        toolLength: robot.toolLength,
        fingerLength: robot.fingerLength,
        fingerWidth: robot.fingerWidth,
        fingerDepth: robot.fingerDepth,
      }),
    });
    this.theme = themes[themeId].create(this.layout);
    scene.add(this.hemisphere);
    const sun = this.sun,
      center = new THREE.Vector3(
        ...(sim.config.environment.robot.base as [number, number, number]),
      );
    const radius = Math.max(
        2.4,
        sim.config.environment.robot.links.reduce((a, b) => a + b, 0) + 0.5,
      ),
      offset = new THREE.Vector3(...this.theme.environment.sunOffset);
    sun.target.position.copy(center);
    sun.position.copy(center).add(offset);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, {
      left: -radius,
      right: radius,
      top: radius,
      bottom: -radius,
      near: offset.length() - radius,
      far: offset.length() + radius,
    });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.normalBias = 0.003;
    sun.shadow.bias = -0.0001;
    sun.shadow.radius = 2;
    sun.shadow.blurSamples = 8;
    scene.add(sun, sun.target);
    this.installTheme(this.theme);
    const mesh = (
      geometry: THREE.BufferGeometry,
      slot: MaterialSlot | number,
      x: number,
      y: number,
      z: number,
    ) => {
      this.geometries.add(geometry);
      const material =
        typeof slot === 'number'
          ? this.theme.blocks[slot % this.theme.blocks.length]
          : this.theme.materials[slot];
      const object = new THREE.Mesh(geometry, material);
      object.position.set(x, y, z);
      object.castShadow = object.receiveShadow = true;
      scene.add(object);
      this.bindings.push({ object, slot });
      return object;
    };
    const box = (
      w: number,
      h: number,
      d: number,
      slot: MaterialSlot,
      x: number,
      y: number,
      z: number,
      radius = 0.08,
    ) => mesh(new RoundedBoxGeometry(w, h, d, 3, radius), slot, x, y, z);
    const surfaceThickness = 0.015;
    const baseThickness = sim.config.environment.tableThickness - surfaceThickness;
    // Separate the slab and inset surface to prevent coplanar depth flicker.
    box(
      tableSize,
      baseThickness,
      depth,
      'table',
      0,
      TABLE_TOP - surfaceThickness - baseThickness / 2,
      0,
      0.025,
    );
    box(
      tableSize - 0.03,
      surfaceThickness,
      depth - 0.03,
      'surface',
      0,
      TABLE_TOP - surfaceThickness / 2,
      0,
      0.005,
    );
    for (const leg of tableFrame(sim.config.environment))
      box(...leg.size, 'table', ...leg.position, 0.007);
    for (const axis of ['x', 'z'] as const) {
      const span = axis === 'x' ? tableSize : depth;
      const count = Math.round(span / 0.15);
      for (let i = 1; i < count; i++) {
        const offset = -span / 2 + (i * span) / count;
        box(
          axis === 'x' ? 0.001 : tableSize - 0.04,
          0.0004,
          axis === 'z' ? 0.001 : depth - 0.04,
          'grid',
          axis === 'x' ? offset : 0,
          TABLE_TOP + 0.0003,
          axis === 'z' ? offset : 0,
          0.0001,
        ).castShadow = false;
      }
    }

    const c = sim.config.environment.robot;
    const body = humanoidBody(c, mesh, headPitch);
    body.name = 'robot-body';
    scene.add(body);
    this.pickables.push(body);
    this.reflections = robotReflections();
    scene.environment = this.reflections;
    scene.environmentIntensity = 0.6;
    const baseAnchor = this.baseAnchor;
    baseAnchor.position.set(c.base[0], c.base[1], c.base[2]);
    scene.add(baseAnchor);
    const anchor = new THREE.Object3D();
    this.armAnchors.push(anchor);
    scene.add(anchor);
    this.robotMeshes = sim.arms.flatMap(() =>
      c.links.map((_, i) => {
        const group = humanoidLink(c, i, mesh);
        scene.add(group);
        return group;
      }),
    );
    this.pickables.push(...this.robotMeshes);
    this.fingers = sim.arms
      .flatMap((arm) => arm.fingers)
      .map((_, i) => {
        const group = humanoidFinger(c, i % 2 === 0 ? -1 : 1, mesh);
        scene.add(group);
        return group;
      });
    this.pickables.push(...this.fingers);
    this.blocks = sim.objects.map((object) => {
      const shape = object.shape;
      const geometry =
        shape.kind === 'cuboid'
          ? new THREE.BoxGeometry(...shape.size)
          : shape.kind === 'cylinder'
            ? new THREE.CylinderGeometry(shape.radius, shape.radius, shape.height, 32)
            : new THREE.SphereGeometry(shape.radius, 24, 16);
      const material = new THREE.MeshStandardMaterial({
        color: OBJECT_COLORS[object.color],
        roughness: 0.85,
      });
      const result = new THREE.Mesh(geometry, material);
      result.castShadow = true;
      result.receiveShadow = true;
      this.geometries.add(geometry);
      this.scene.add(result);
      return result;
    });
    this.sync();
  }
  private installTheme(theme: ThemeInstance) {
    const env = theme.environment;
    this.scene.background = new THREE.Color(env.background);
    this.scene.fog = new THREE.Fog(env.background, 15, 30);
    this.hemisphere.color.set(env.sky);
    this.hemisphere.groundColor.set(env.ground);
    this.hemisphere.intensity = env.ambient;
    this.sun.color.set(env.sun);
    this.sun.intensity = env.sunIntensity;
    const offset = new THREE.Vector3(...env.sunOffset);
    this.sun.position.copy(this.sun.target.position).add(offset);
    const radius = this.sim.config.environment.robot.links.reduce((a, b) => a + b, 0) + 0.5;
    this.sun.shadow.camera.near = offset.length() - radius;
    this.sun.shadow.camera.far = offset.length() + radius;
    this.sun.shadow.camera.updateProjectionMatrix();
    for (const entry of this.shadows.values()) entry.shadow.camera.copy(this.sun.shadow.camera);
    this.scene.add(theme.decorations);
  }
  setTheme(id: ThemeId) {
    validateTheme(id);
    if (id === this.themeId) return;
    const next = themes[id].create(this.layout),
      old = this.theme;
    this.installTheme(next);
    for (const { object, slot } of this.bindings)
      object.material =
        typeof slot === 'number' ? next.blocks[slot % next.blocks.length] : next.materials[slot];
    this.scene.remove(old.decorations);
    this.theme = next;
    this.themeId = id;
    this.visualRevision++;
    old.dispose();
  }
  sync() {
    {
      const root = this.scene.getObjectByName('moving-torso')!,
        pose = this.sim.body.transform();
      root.position.copy(pose.position);
      root.quaternion.copy(pose.rotation);
      this.armAnchors.forEach((anchor, i) => {
        anchor.position.copy(this.sim.arms[i].bodies[0].translation());
        anchor.quaternion.copy(this.sim.body.rotation());
      });
    }
    const bodies = this.sim.arms.flatMap((arm) => arm.bodies),
      fingers = this.sim.arms.flatMap((arm) => arm.fingers);
    this.robotMeshes.forEach((g, i) => {
      g.position.copy(bodies[i].translation());
      g.quaternion.copy(bodies[i].rotation());
    });
    this.fingers.forEach((g, i) => {
      g.position.copy(fingers[i].translation());
      g.quaternion.copy(fingers[i].rotation());
    });
    this.blocks.forEach((g, i) => {
      g.position.copy(this.sim.bodies[i].translation());
      g.quaternion.copy(this.sim.bodies[i].rotation());
    });
  }
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    let entry = this.shadows.get(renderer);
    if (!entry) {
      entry = { shadow: this.sun.shadow.clone(), tick: -1, revision: -1 };
      this.shadows.set(renderer, entry);
    }
    const original = this.sun.shadow;
    this.sun.shadow = entry.shadow;
    renderer.shadowMap.needsUpdate =
      entry.tick !== this.sim.ticks || entry.revision !== this.visualRevision;
    try {
      renderer.render(this.scene, camera);
      entry.tick = this.sim.ticks;
      entry.revision = this.visualRevision;
    } finally {
      this.sun.shadow = original;
    }
  }
  releaseRenderer(renderer: THREE.WebGLRenderer) {
    this.shadows.get(renderer)?.shadow.dispose();
    this.shadows.delete(renderer);
  }
  dispose() {
    this.scene.remove(this.theme.decorations);
    this.theme.dispose();
    this.blocks.forEach((b) => (b.material as THREE.Material).dispose());
    this.geometries.forEach((geometry) => geometry.dispose());
    this.geometries.clear();
    this.bindings = [];
    this.shadows.forEach((e) => e.shadow.dispose());
    this.shadows.clear();
    this.sun.shadow.dispose();
    this.reflections?.dispose();
    this.scene.environment = null;
    this.scene.clear();
  }
}
