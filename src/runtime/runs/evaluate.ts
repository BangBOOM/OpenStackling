import type { Config } from '../config';
import { buildEpisodePlan } from '../plan';
import { evaluationStore } from '../recording/result-store';
import { BrowserExecutor, NodeExecutor } from './executor';
import { executePlan } from './run';
import { type RunOptions } from './contracts';
export function evaluate(config: Config, options: RunOptions) {
  if (options.workers !== 1) throw new Error('Evaluation requires one worker');
  const plan = buildEpisodePlan(config, { ...options, fixedCamera: Boolean(options.policy) });
  return executePlan(
    config,
    plan,
    options,
    evaluationStore,
    options.policy || options.visible ? new BrowserExecutor(options, false) : new NodeExecutor(),
  );
}
