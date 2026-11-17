import type { Config } from '../config';
import { buildEpisodePlan } from '../plan';
import { datasetStore } from '../recording/result-store';
import { BrowserExecutor } from './executor';
import { executePlan } from './run';
import { type RunOptions } from './contracts';
export function collect(config: Config, options: RunOptions) {
  const plan = buildEpisodePlan(config, { ...options, fixedCamera: Boolean(options.policy) });
  return executePlan(config, plan, options, datasetStore, new BrowserExecutor(options, true));
}
