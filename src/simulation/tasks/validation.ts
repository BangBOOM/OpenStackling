import { dimensions, isCube, type SceneSpec } from '../world/objects.js';
export function requireCubes(scene: SceneSpec) {
  if (scene.objects.some((o) => !isCube(o.shape)))
    throw new Error('Completion tasks require cubes');
}
export function partitionSize(scene: SceneSpec) {
  requireCubes(scene);
  const size = dimensions(scene.objects[0].shape)[0];
  if (scene.objects.some((o) => dimensions(o.shape)[0] !== size))
    throw new Error('Partition tasks require equal cubes');
  return size;
}
