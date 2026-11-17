import defaults from '../../../configs/default.json' with { type: 'json' };

export const WHOLE_BODY_TEACHER_VERSION = 7;

export const DEFAULT_TEACHER_POLICY = defaults.teacher.policy;
export type TeacherPolicy = typeof DEFAULT_TEACHER_POLICY;

export type TeacherConfig = typeof defaults.teacher & { policy: TeacherPolicy };
