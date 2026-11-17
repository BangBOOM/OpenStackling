import type { TaskResult, TaskSummary } from './types.js';
export function completionSummary(rows: TaskResult[]): TaskSummary {
  const successes = rows.filter((r) => r.outcome === 'success').length;
  return {
    episodes: rows.length,
    successes,
    successRate: rows.length ? successes / rows.length : 0,
    failures: rows.length - successes,
  };
}
export function heightSummary(rows: TaskResult[]): TaskSummary {
  const heights = rows
      .filter((r) => r.outcome === 'completed')
      .map((r) => r.evaluation.heightMeters)
      .sort((a, b) => a - b),
    n = heights.length;
  return {
    episodes: rows.length,
    completed: n,
    failures: rows.length - n,
    heightMeters: {
      count: n,
      min: n ? heights[0] : null,
      max: n ? heights[n - 1] : null,
      mean: n ? heights.reduce((a, b) => a + b, 0) / n : null,
      median: n ? (heights[Math.floor((n - 1) / 2)] + heights[Math.floor(n / 2)]) / 2 : null,
    },
  };
}
