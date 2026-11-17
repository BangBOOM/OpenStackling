import { WholeBodyTeacher } from '../../simulation/control/teachers/whole-body';
import { teacherContext } from '../../simulation/control/teachers/types';
import type { Simulation } from '../../simulation/world/simulation';
import type { Config } from '../config';
import type { ActionSource } from '../episode-types';
import type { PlanningWork } from '../../simulation/control/planning-work';
export class TeacherSource implements ActionSource {
  readonly name = 'teacher';
  teacher: WholeBodyTeacher;
  constructor(
    private sim: Simulation,
    private config: Config,
  ) {
    this.teacher = new WholeBodyTeacher(sim, teacherContext(config));
  }
  reset() {
    this.teacher = new WholeBodyTeacher(this.sim, teacherContext(this.config));
  }
  next(dt: number) {
    return this.teacher.next(dt);
  }
  afterStep(): void | PlanningWork {
    return this.teacher.updateSteps();
  }
  get failure() {
    return this.teacher.phase === 'failed' ? this.teacher.reason : undefined;
  }
  end() {}
}

export const teacherSource = (sim: Simulation, config: Config) => new TeacherSource(sim, config);
