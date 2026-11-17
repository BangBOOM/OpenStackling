import type { EpisodePlan } from '../plan';
import { summarizeTask } from '../../simulation/tasks/registry';
import type { TaskEvaluation, TaskSpec } from '../../simulation/tasks/types';
export type CompletedEpisode = {
  seed: number;
  outcome: string;
  taskKind: TaskSpec['kind'];
  caseIndex: number;
  evaluation: TaskEvaluation;
};
export function summarizeRun(plan: EpisodePlan[], completed: Record<string, CompletedEpisode>) {
  const entries = Object.entries(completed).sort(([a], [b]) => a.localeCompare(b));
  const byTask = Object.fromEntries(
    [...new Set(plan.map((p) => p.task.spec.kind))].map((kind) => [
      kind,
      summarizeTask(
        kind,
        entries.filter(([, e]) => e.taskKind === kind).map(([, e]) => e),
      ),
    ]),
  );
  const byCase = [...new Set(plan.map((p) => p.caseIndex))].map((caseIndex) => {
    const task = plan.find((p) => p.caseIndex === caseIndex)!.task;
    const episodes = entries
      .filter(([, e]) => e.caseIndex === caseIndex)
      .map(([id, e]) => ({ id, seed: e.seed, outcome: e.outcome, evaluation: e.evaluation }));
    return { caseIndex, task, episodes, summary: summarizeTask(task.spec.kind, episodes) };
  });
  return { byTask, byCase };
}
