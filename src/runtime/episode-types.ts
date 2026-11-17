import type { Action, State, WorldSnapshot, Outcome } from '../simulation/world/types';
import type { PlanningWork } from '../simulation/control/planning-work';
export type Advice = {
  action: Action;
  valid: boolean;
  reason: string;
  phase: string;
  continuous?: boolean;
};
export interface ActionSource {
  name: string;
  reset(): void;
  initialize?(): Promise<void>;
  observe?(row: ObservationRow): Promise<void>;
  cancel?(): void;
  next(dt: number): Advice | Promise<Advice>;
  afterStep?(): void | PlanningWork;
  readonly failure?: string;
  end(result: EpisodeResult): void | Promise<void>;
}
export type ObservationRow = {
  tick: number;
  time: number;
  state: State;
  cameraToWorld: number[];
  rgb?: string;
  depth?: string;
};
export type ActionRow = {
  tick: number;
  time: number;
  executed_action: Action;
  controller: string;
  teacher_action?: Action;
  label_valid?: boolean;
  continuous: boolean;
};
export type DiagnosticRow = { tick: number; time: number; phase: string; snapshot: WorldSnapshot };
export interface EpisodeSink {
  observation?(row: ObservationRow): void | Promise<void>;
  action?(row: ActionRow): void | Promise<void>;
  diagnostic?(row: DiagnosticRow): void | Promise<void>;
}
export type EpisodeResult = {
  outcome: Outcome;
  reason: string;
  ticks: number;
  seconds: number;
  observations: number;
  actions: number;
  final: WorldSnapshot;
  stableSeconds: number;
  evaluation: import('../simulation/tasks/types').TaskEvaluation;
  task: import('../simulation/tasks/types').ResolvedTask;
  controlTicks: number;
  validationTicks: number;
  wallSeconds: number;
  physicsMs: number;
  observationMs: number;
  controlMs: number;
  recordMs: number;
};
