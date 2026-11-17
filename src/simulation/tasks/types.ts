import type { SceneSpec } from '../world/objects.js';
import type { Simulation } from '../world/simulation.js';
export type Language = 'en' | 'zh';
type TaskRules = { language: Language; stableSeconds: number };
export type TaskSpec = TaskRules &
  (
    | { kind: 'tower'; order: 'any' | 'size-ascending' | 'size-descending' }
    | { kind: 'partition-count'; counts: number[] }
    | { kind: 'partition-color' }
    | { kind: 'max-height' }
  );
export type TaskPrompt = {
  templateId: string;
  templateVersion: number;
  language: Language;
  text: string;
};
export type TaskEvaluation = {
  kind: TaskSpec['kind'];
  success: boolean;
  completed: number;
  total: number;
  groups: number;
  totalGroups: number;
  heightMeters: number;
  stableSeconds: number;
};
export type ResolvedTask = {
  version: number;
  mode: 'completion' | 'deadline';
  spec: TaskSpec;
  prompt: TaskPrompt;
  controlSeconds: number;
  validationSeconds: number;
};
export type TaskDefinition = {
  version: number;
  mode: 'completion' | 'deadline';
  kind: TaskSpec['kind'];
  summarize(results: TaskResult[]): TaskSummary;
  validate(spec: TaskSpec, scene: SceneSpec): void;
  describe(spec: TaskSpec, scene: SceneSpec, seconds: number): string;
  evaluate(
    sim: Simulation,
    structures: import('./structures.js').Structure[],
    spec: TaskSpec,
  ): Omit<TaskEvaluation, 'stableSeconds'>;
};

export type TaskResult = { outcome: string; evaluation: TaskEvaluation };
export type TaskSummary = {
  episodes: number;
  successes?: number;
  successRate?: number;
  completed?: number;
  failures: number;
  heightMeters?: {
    count: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    median: number | null;
  };
};
