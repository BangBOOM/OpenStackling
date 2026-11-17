import type { RobotConfig } from './config';
export const actionLimits = (config: RobotConfig) => [
  [-config.body.yawLimit, config.body.yawLimit],
  [0, config.body.pitchLimit],
  ...config.limits,
  config.gap,
  ...config.limits,
  config.gap,
];
