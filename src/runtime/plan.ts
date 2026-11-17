import { resolveConfig, type Config } from './config';
import { CAMERA_POSITIONS, type CameraPosition } from '../simulation/sensors/config';
import { scenePatch, resolveScene, type SceneRequest } from '../simulation/scene';
import { resolveTask } from '../simulation/tasks/registry';
import { appearanceIdentity } from './appearance';
import { random } from '../simulation/world/random';
export type ResolvedEpisode = {
  config: Config;
  resolvedScene: ReturnType<typeof resolveScene>;
  task: ReturnType<typeof resolveTask>;
  appearance: ReturnType<typeof appearanceIdentity>;
};
export type EpisodePlan = ResolvedEpisode & { id: string; caseIndex: number };
export type PlanOptions = {
  seeds: number[];
  cases?: Config[];
  positions?: string[];
  sceneGeneration?: SceneRequest;
  fixedCamera?: boolean;
};
export function resolveEpisode(
  config: Config,
  generation: SceneRequest = { kind: 'fixed' },
): ResolvedEpisode {
  const c = resolveConfig(config, scenePatch(config, config.run.seed, generation));
  return {
    config: c,
    resolvedScene: resolveScene(c),
    task: resolveTask(c),
    appearance: appearanceIdentity(c.appearance.theme),
  };
}
export function buildEpisodePlan(config: Config, options: PlanOptions): EpisodePlan[] {
  if (
    !options.seeds.length ||
    options.seeds.some((s) => !Number.isInteger(s) || s < 0 || s > 0xffffffff)
  )
    throw new Error('Seeds must be uint32 values');
  if (options.cases && !options.cases.length) throw new Error('Task suite requires nonempty cases');
  if (options.positions && (options.cases ?? [config]).some((c) => c.camera.mount === 'head'))
    throw new Error('Head camera cannot randomize external positions');
  const views = options.positions ?? [config.camera.position];
  if (!views.length || views.some((p) => !CAMERA_POSITIONS.includes(p as CameraPosition)))
    throw new Error('Invalid camera positions');
  return (options.cases ?? [config])
    .flatMap((base, caseIndex) =>
      options.seeds.map((seed, seedIndex) => {
        const c = structuredClone(base);
        c.run.seed = seed;
        if (!options.fixedCamera) {
          c.run.cameraSeed = (base.run.cameraSeed + seedIndex) >>> 0;
          const positions = options.positions ?? [base.camera.position];
          c.camera.position = positions[Math.floor(random(c.run.cameraSeed)() * positions.length)];
        }
        const resolved = resolveEpisode(c, options.sceneGeneration);
        return { ...resolved, id: '', caseIndex };
      }),
    )
    .map((entry, index) => ({ ...entry, id: String(index).padStart(6, '0') }));
}
