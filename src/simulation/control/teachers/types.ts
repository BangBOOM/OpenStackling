import type { Quat, Vec3 } from '../../world/types';
export const PLACEMENT_ALIGNMENT = 0.995;
export type Placement = { object: number; support: number | null; position: Vec3; rotation: Quat };
export type TeacherContext = {
  task: import('../../tasks/types').TaskSpec;
  teacher: import('../teacher-policy').TeacherConfig;
  maxSeconds: number;
  maxStackHeight: number;
};
export function teacherContext(config: {
  task: TeacherContext['task'];
  teacher: TeacherContext['teacher'];
  run: { maxSeconds: number };
  scene: { maxStackHeight: number };
}): TeacherContext {
  return {
    task: config.task,
    teacher: config.teacher,
    maxSeconds: config.run.maxSeconds,
    maxStackHeight: config.scene.maxStackHeight,
  };
}
