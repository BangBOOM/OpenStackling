import type { Placement } from './types';

export type PlacementCandidate = Placement & {
  key: string;
  // Dimensionless task utility; larger values are preferred among feasible plans.
  value: number;
};

export interface WholeBodyPlanner {
  candidates(): PlacementCandidate[];
  placed(goal: PlacementCandidate): void;
  rejected(goal: PlacementCandidate): void;
  readonly done: boolean;
  readonly allowPartial?: boolean;
  readonly failure?: string;
}

export type TeacherDecision = {
  arm: number;
  object: number;
  grasp: string;
  waist: number[];
  cost: number;
};
