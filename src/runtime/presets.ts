import defaults from '../../configs/default.json' with { type: 'json' };
import { scenePatch, generatedObjects, type SceneRequest } from '../simulation/scene';
import type { Config, DeepPartial } from './config';
import { cubeObjects, dimensions } from '../simulation/world/objects';
export const TASK_PRESETS = [
  'stack-all',
  'partition-count',
  'partition-color',
  'stack-sized',
  'stack-ordered',
  'max-height',
] as const;
export type TaskPreset = (typeof TASK_PRESETS)[number];
export function taskPreset(config: Config): TaskPreset {
  if (config.task.kind !== 'tower') return config.task.kind;
  if (config.task.order !== 'any') return 'stack-ordered';
  return new Set(config.scene.objects.map((o) => dimensions(o.shape)[0])).size > 1
    ? 'stack-sized'
    : 'stack-all';
}
export function presetPatch(preset: TaskPreset, seed = 42): DeepPartial<Config> {
  const common = { language: 'en' as const, stableSeconds: defaults.task.stableSeconds };
  switch (preset) {
    case 'stack-all':
      return {
        scene: { objects: cubeObjects(2) },
        task: { ...common, kind: 'tower', order: 'any' },
        run: { maxSeconds: 120 },
      };
    case 'partition-count':
      return {
        scene: { objects: cubeObjects(8) },
        task: { ...common, kind: 'partition-count', counts: [2, 2, 2, 2] },
        run: { maxSeconds: 480 },
      };
    case 'partition-color':
      return {
        scene: { objects: cubeObjects(8, 0.05, [2, 2, 2, 2]) },
        task: { ...common, kind: 'partition-color' },
        run: { maxSeconds: 480 },
      };
    case 'stack-sized':
      return {
        scene: {
          objects: generatedObjects({ kind: 'random-sized', version: 2, count: 3 }, seed, 0.3),
        },
        task: { ...common, kind: 'tower', order: 'any' },
        run: { maxSeconds: 240 },
      };
    case 'stack-ordered':
      return {
        scene: {
          objects: generatedObjects({ kind: 'random-sized', version: 2, count: 3 }, seed, 0.3),
        },
        task: { ...common, kind: 'tower', order: 'size-descending' },
        run: { maxSeconds: 240 },
      };
    case 'max-height':
      return {
        scene: {
          objects: generatedObjects({ kind: 'random-mixed', version: 2, count: 6 }, seed, 0.3),
        },
        task: { ...common, kind: 'max-height' },
        run: { maxSeconds: 240 },
      };
  }
}
export function randomScenePatch(
  config: Config,
  seed: number,
  count = config.scene.objects.length,
): DeepPartial<Config> {
  return scenePatch(config, seed, generationForPreset(taskPreset(config), count));
}
export function generationForPreset(preset: TaskPreset, count: number): SceneRequest {
  if (preset === 'max-height') return { kind: 'random-mixed', version: 2, count };
  if (preset === 'stack-sized' || preset === 'stack-ordered')
    return { kind: 'random-sized', version: 2, count };
  return { kind: 'fixed' };
}
export function collectionGeneration(
  config: Config,
  overrides: { fixedSize: boolean; fixedObjects: boolean; suite: boolean; count: boolean },
): SceneRequest | undefined {
  if (
    config.task.kind === 'max-height' &&
    !overrides.suite &&
    !overrides.fixedSize &&
    (overrides.count || !overrides.fixedObjects)
  )
    return generationForPreset('max-height', config.scene.objects.length);
  return undefined;
}
