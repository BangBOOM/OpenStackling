import {
  CAMERA_POSITIONS,
  type CameraConfig,
  type CameraPosition,
} from '../simulation/sensors/config.js';
import {
  DEFAULT_TEACHER_POLICY,
  type TeacherConfig,
  type TeacherPolicy,
} from '../simulation/control/teacher-policy.js';
import defaults from '../../configs/default.json' with { type: 'json' };
import robot from '../../configs/robot.json' with { type: 'json' };
import {
  validateEnvironment,
  validateObjects,
  type EnvironmentConfig,
} from '../simulation/world/config.js';
import type { SceneSpec } from '../simulation/world/objects.js';
import type { TaskSpec } from '../simulation/tasks/types.js';
import { validateTask } from '../simulation/tasks/registry.js';
import { positive, integer, finiteTree } from '../simulation/validation.js';
import { validateTheme, type ThemeId } from './theme-catalog.js';
export type Config = {
  environment: EnvironmentConfig;
  scene: SceneSpec;
  task: TaskSpec;
  teacher: TeacherConfig;
  camera: CameraConfig;
  run: typeof defaults.run;
  appearance: { theme: ThemeId };
};
export type AppearanceConfig = Config['appearance'];
export type RuntimeConfig = Pick<Config, 'environment' | 'camera'> & {
  run: Pick<Config['run'], 'controlHz' | 'observationHz'>;
};
export type DeepPartial<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends unknown[]
    ? T[K]
    : NonNullable<T[K]> extends object
      ? DeepPartial<NonNullable<T[K]>>
      : T[K];
};
export function merge<T>(base: T, patch: DeepPartial<T>): T {
  const result = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(result, key)) throw new Error(`Unknown configuration key: ${key}`);
    if (
      key === 'task' &&
      value &&
      typeof value === 'object' &&
      'kind' in value &&
      value.kind !== (result[key] as TaskSpec).kind
    ) {
      const previous = result[key] as TaskSpec;
      result[key] = {
        language: previous.language,
        stableSeconds: previous.stableSeconds,
        ...value,
      };
      continue;
    }
    result[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? merge(result[key], value)
        : value;
  }
  return result as T;
}

export function resolveConfig(...patches: DeepPartial<Config>[]): Config {
  const config = patches.reduce<Config>((base, patch) => merge(base, patch), {
    ...structuredClone(defaults),
    scene: structuredClone(defaults.scene) as SceneSpec,
    camera: structuredClone(defaults.camera) as CameraConfig,
    environment: { ...defaults.environment, robot: structuredClone(robot) } as EnvironmentConfig,
    task: structuredClone(defaults.task) as TaskSpec,
    appearance: { theme: 'island' },
  });
  if (
    patches.some((p) => p.scene?.objects !== undefined) &&
    !patches.some((p) => p.run?.maxSeconds !== undefined)
  )
    config.run.maxSeconds = config.scene.objects.length > 2 ? 240 : 120;
  validateConfig(config);
  return config;
}
export function validateRuntimeConfig(c: RuntimeConfig) {
  finiteTree(c);
  validateEnvironment(c.environment);
  if (typeof c.camera.depth !== 'boolean') throw new Error('Depth must be boolean');
  for (const rate of [c.run.controlHz, c.run.observationHz]) {
    integer(rate, 'rate');
    if (c.environment.physicsHz % rate !== 0) throw new Error('Rates must divide physicsHz');
  }
  const a = c.camera;
  if (a.mount !== 'external' && a.mount !== 'head') throw new Error('Invalid camera mount');
  const head = a.head;
  if (!head || typeof head !== 'object') throw new Error('Invalid head camera');
  if (
    head.pitch < 40 ||
    head.pitch > 70 ||
    head.fov < 40 ||
    head.fov > 100 ||
    head.near <= 0 ||
    head.near >= a.far
  )
    throw new Error('Invalid head camera');
  integer(a.width, 'camera width');
  integer(a.heightPixels, 'camera height');
  if (a.width > 4096 || a.heightPixels > 4096) throw new Error('Camera resolution exceeds 4096');
  if (
    !CAMERA_POSITIONS.includes(a.position as CameraPosition) ||
    a.target.length !== 3 ||
    a.fov <= 0 ||
    a.fov >= 150 ||
    a.near <= 0 ||
    a.far <= (a.mount === 'head' ? head.near : a.near) ||
    a.far > 65
  )
    throw new Error('Invalid camera');
  positive(a.distance, 'camera distance');
  positive(a.height, 'camera height');
}
export function validateConfig(c: Config) {
  validateRuntimeConfig(c);
  validateObjects(c.scene.objects);
  if (typeof c.scene.clearance !== 'boolean') throw new Error('Clearance must be boolean');
  positive(c.scene.maxStackHeight, 'maxStackHeight');
  integer(c.scene.maxAttempts, 'maxAttempts');
  for (const seed of [c.run.seed, c.run.cameraSeed])
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw new Error('Seed must be uint32');
  const [xmin, xmax, zmin, zmax] = c.scene.region;
  const half = c.environment.tableSize / 2;
  if (
    c.scene.region.length !== 4 ||
    c.scene.region.some((v) => !Number.isFinite(v)) ||
    xmin >= xmax ||
    zmin >= zmax ||
    Math.max(Math.abs(xmin), Math.abs(xmax)) > half ||
    Math.max(Math.abs(zmin), Math.abs(zmax)) > c.environment.tableDepth / 2
  )
    throw new Error('Invalid sampling region');

  validateTask(c.task, c.scene);
  positive(c.run.maxSeconds, 'maxSeconds');
  for (const key of ['transitSpeed', 'precisionSpeed', 'contactSeconds', 'settleSeconds'] as const)
    positive(c.teacher[key], 'teacher parameter');
  for (const value of Object.values(c.teacher.grasp)) positive(value, 'grasp feedback parameter');
  if (c.teacher.policy)
    for (const key of Object.keys(DEFAULT_TEACHER_POLICY) as (keyof TeacherPolicy)[]) {
      const value = c.teacher.policy[key];
      if (!Number.isFinite(value) || value < 0 || value > 10)
        throw new Error(`Invalid teacher policy parameter: ${key}`);
    }
  validateTheme(c.appearance.theme);
}
