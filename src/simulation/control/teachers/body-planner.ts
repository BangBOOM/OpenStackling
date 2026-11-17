import type { Simulation } from '../../world/simulation';
import type { TeacherContext } from './types';
import type { WholeBodyPlanner } from './whole-body-types';
import { BodyTowerPlanner } from './body-tower';
import { BodyPartitionPlanner } from './body-partition';
import { BodyHeightPlanner } from './body-height';

export function bodyPlanner(sim: Simulation, context: TeacherContext): WholeBodyPlanner {
  if (context.task.kind === 'tower') return new BodyTowerPlanner(sim, context);
  if (context.task.kind === 'max-height') return new BodyHeightPlanner(sim, context);
  return new BodyPartitionPlanner(sim, context.task);
}
