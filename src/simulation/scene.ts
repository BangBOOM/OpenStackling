import { halfExtent, type SceneSpec, type ResolvedScene } from './world/objects';
import type { EnvironmentConfig, WorldConfig } from './world/config';
import { randomMixedObjects, randomSizedObjects, scaledObjects } from './world/objects';
import { integer } from './validation';
import { random } from './world/random';
type SceneInput = { environment: EnvironmentConfig; scene: SceneSpec; run: { seed: number } };
export function samplePositions(c: SceneInput) {
  const rng = random(c.run.seed),
    positions: { x: number; y: number; z: number }[] = [];
  const [xmin, xmax, zmin, zmax] = c.scene.region,
    objects = c.scene.objects,
    r = c.environment.robot;
  // Tool Z is world X. The open gripper sweeps a rectangle around each block.
  const extents = objects.map((o) => ({
    x: halfExtent(o.shape, o.rotation, { x: 1, y: 0, z: 0 }),
    y: halfExtent(o.shape, o.rotation),
    z: halfExtent(o.shape, o.rotation, { x: 0, y: 0, z: 1 }),
  }));
  for (
    let attempt = 0;
    attempt < c.scene.maxAttempts && positions.length < c.scene.objects.length;
    attempt++
  ) {
    // Restart a crowded human-scale layout deterministically within the attempt budget.
    if (attempt > 0 && attempt % 256 === 0) positions.length = 0;
    const e = extents[positions.length];
    const p = {
      x: xmin + rng() * (xmax - xmin),
      y: c.environment.tableTop + e.y,
      z: zmin + rng() * (zmax - zmin),
    };
    if (
      Math.abs(p.x) + e.x <= c.environment.tableSize / 2 &&
      Math.abs(p.z) + e.z <= c.environment.tableDepth / 2 &&
      positions.every((q, i) => {
        const other = extents[i];
        const clearanceX = c.scene.clearance
          ? r.gap[1] / 2 + r.fingerWidth + Math.max(e.x, other.x) + 0.01
          : e.x + other.x + 0.001;
        const clearanceZ = c.scene.clearance
          ? Math.max(r.fingerDepth / 2, e.z, other.z) + Math.max(e.z, other.z) + 0.01
          : e.z + other.z + 0.001;
        return Math.abs(p.x - q.x) >= clearanceX || Math.abs(p.z - q.z) >= clearanceZ;
      })
    )
      positions.push(p);
  }
  if (positions.length !== c.scene.objects.length)
    throw new Error('Layout generation exhausted maxAttempts');
  return positions;
}

export function resolveScene(config: SceneInput): ResolvedScene {
  const positions = samplePositions(config);
  return config.scene.objects.map((object, i) => ({
    ...structuredClone(object),
    position: positions[i],
  }));
}
export function worldConfig(config: SceneInput): WorldConfig {
  return { environment: config.environment, scene: resolveScene(config) };
}

export type SceneRequest =
  | { kind: 'fixed' }
  | { kind: 'random-mixed' | 'random-sized'; version: 2; count: number };
export function scenePatch(
  config: SceneInput,
  seed: number,
  request: SceneRequest,
): { scene?: { objects: SceneSpec['objects'] } } {
  if (request.kind === 'fixed') return {};
  return { scene: { objects: generatedObjects(request, seed, config.scene.maxStackHeight) } };
}
export function generatedObjects(
  request: Exclude<SceneRequest, { kind: 'fixed' }>,
  seed: number,
  maxHeight: number,
) {
  integer(request.count, 'object count');
  if (request.version !== 2) throw new Error('Unsupported scene generator version');
  const scale = 5 / 9;
  const objects =
    request.kind === 'random-mixed'
      ? randomMixedObjects(request.count, seed)
      : randomSizedObjects(request.count, seed, maxHeight / scale);
  return scaledObjects(objects, scale);
}
