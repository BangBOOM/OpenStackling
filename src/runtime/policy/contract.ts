import { resolveTask } from '../../simulation/tasks/registry';
import type { TaskPrompt, TaskSpec } from '../../simulation/tasks/types';
import type { SceneSpec } from '../../simulation/world/objects';
import Ajv2020 from 'ajv/dist/2020';
import { canonicalize } from 'json-canonicalize';
import schema from '../../../protocol/schema.json';
import { appearanceIdentity, type AppearanceIdentity } from '../appearance';
import { resolveConfig, validateConfig, type Config } from '../config';
import type { Action16D } from '../../simulation/world/types';
import { actionLimits } from '../../simulation/world/actions';
import { validateRuntimeConfig } from '../config';
export const PROTOCOL = schema.$defs.protocol.const;
export const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
export type ProfileConfig = Omit<Config, 'teacher' | 'run' | 'appearance' | 'scene' | 'task'> & {
  run: Pick<Config['run'], 'controlHz' | 'observationHz'>;
};
export type TaskCase = { scene: SceneSpec; task: TaskSpec; maxSeconds: number; prompt: TaskPrompt };
export type Profile = {
  profileId: string;
  environmentFingerprint: string;
  trainingAppearance: AppearanceIdentity;
  config: ProfileConfig;
  trainingTasks: TaskCase[];
  io: {
    rgb: 'png-rgb8';
    depth: 'gzip-u16le-mm-zero-invalid';
    action: 'absolute-joints-rad-gap-m';
    state: 'measured-joints-rad-gap-m';
  };
};
export type Manifest = {
  protocol: typeof PROTOCOL;
  policyId: string;
  modelRevision: string;
  profile: Profile;
  profileHash: string;
};
export type Message = {
  type: string;
  sessionId: string;
  episodeId: string | null;
  requestId: number;
  [key: string]: any;
};
export class PolicyError extends Error {
  constructor(
    readonly code: string,
    readonly detail = '',
  ) {
    super(`${code}${detail ? ': ' + detail : ''}`);
  }
}
const ajv = new Ajv2020({ strict: true, strictNumbers: true });
ajv.addSchema(schema);
const validators = Object.fromEntries(
  ['profile', 'message', 'appearance', 'actual'].map((key) => [
    key,
    ajv.compile({ $ref: `${schema.$id}#/$defs/${key}` }),
  ]),
);
export function validate(kind: 'profile' | 'message' | 'appearance' | 'actual', value: unknown) {
  if (!validators[kind](value))
    throw new PolicyError('INVALID_MESSAGE', ajv.errorsText(validators[kind].errors));
}
export async function digest(value: unknown) {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
}
export function profileConfig(config: Config): ProfileConfig {
  const {
    teacher: _teacher,
    appearance: _appearance,
    scene: _scene,
    task: _task,
    run: { seed: _seed, cameraSeed: _cameraSeed, maxSeconds: _seconds, ...run },
    ...rest
  } = structuredClone(config);
  return { ...rest, run };
}
export function makeProfile(
  config: Config,
  environmentFingerprint: string,
  profileId = 'stackling-default',
  cases: Config[] = [config],
): Profile {
  return {
    profileId,
    environmentFingerprint,
    trainingAppearance: appearanceIdentity(config.appearance.theme),
    config: profileConfig(config),
    trainingTasks: cases.map((c) => {
      if (canonicalize(profileConfig(c)) !== canonicalize(profileConfig(config)))
        throw new PolicyError('CONFIG_MISMATCH', 'Task cases must share runtime configuration');
      validateConfig(c);
      return taskCase(c);
    }),
    io: {
      rgb: 'png-rgb8',
      depth: 'gzip-u16le-mm-zero-invalid',
      action: 'absolute-joints-rad-gap-m',
      state: 'measured-joints-rad-gap-m',
    },
  };
}
export function validateProfile(profile: Profile) {
  validate('profile', profile);
  validateRuntimeConfig(profile.config);
  const defaults = resolveConfig();
  for (const selected of profile.trainingTasks) {
    validateConfig({
      ...defaults,
      ...profile.config,
      scene: selected.scene,
      task: selected.task,
      run: { ...defaults.run, ...profile.config.run, maxSeconds: selected.maxSeconds },
    });
    if (
      selected.prompt.language !== selected.task.language ||
      selected.prompt.templateId !== selected.task.kind
    )
      throw new PolicyError('CONFIG_MISMATCH', 'Training prompt metadata');
  }
}
export function configForProfile(profile: Profile, current = resolveConfig()): Config {
  validateProfile(profile);
  // A Profile carries the complete runtime configuration.
  const config = {
    ...structuredClone(current),
    ...structuredClone(profile.config),
    run: { ...current.run, ...profile.config.run },
  };
  validateConfig(config);
  return config;
}
export function taskCase(config: Config): TaskCase {
  return {
    scene: structuredClone(config.scene),
    task: structuredClone(config.task),
    maxSeconds: config.run.maxSeconds,
    prompt: resolveTask(config).prompt,
  };
}
export function assertCompatible(profile: Profile, config: Config) {
  validateConfig(config);
  if (canonicalize(profile.config) !== canonicalize(profileConfig(config)))
    throw new PolicyError('CONFIG_MISMATCH', 'Runtime configuration');
}
export function actualConfig(
  config: Config,
  appearance = appearanceIdentity(config.appearance.theme),
) {
  return {
    configuration: profileConfig(config),
    taskCase: taskCase(config),
    seed: config.run.seed,
    cameraSeed: config.run.cameraSeed,
    appearance,
  };
}
export function validateAction(action: Action16D, config: ProfileConfig) {
  const limits = actionLimits(config.environment.robot);
  if (
    !Array.isArray(action) ||
    action.length !== 16 ||
    action.some((v, i) => !Number.isFinite(v) || v < limits[i][0] || v > limits[i][1])
  )
    throw new PolicyError('INVALID_ACTION');
}
export function configurationDiff(
  before: unknown,
  after: unknown,
  prefix = '',
): { path: string; before: unknown; after: unknown }[] {
  if (canonicalize(before) === canonicalize(after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(after)
  )
    return Object.keys(after).flatMap((key) =>
      configurationDiff(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        prefix ? `${prefix}.${key}` : key,
      ),
    );
  return [{ path: prefix, before, after }];
}
