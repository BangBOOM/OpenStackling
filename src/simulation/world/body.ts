import { Quaternion, Vector3 } from 'three';
import type { RobotConfig } from './config';

export const waistPivot = (config: RobotConfig) =>
  new Vector3(config.mount.column.x, config.mount.column.bottom, config.mount.column.z);
export function bodyRotation(yaw: number, pitch: number) {
  return new Quaternion()
    .setFromAxisAngle(new Vector3(0, 1, 0), yaw)
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch));
}
export function armConfig(config: RobotConfig, side: number): RobotConfig {
  return {
    ...config,
    base: [
      side === 0 ? config.base[0] : 2 * config.mount.column.x - config.base[0],
      config.base[1],
      config.base[2],
    ],
  };
}
