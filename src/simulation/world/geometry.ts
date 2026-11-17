import { Matrix4, Quaternion, Vector3 } from 'three';
import type { RobotConfig } from './config';
export const armHalfWidth = (config: RobotConfig) => config.visual.armRadius;
export const wristRadii = (config: RobotConfig) => ({
  roll: config.visual.wristRadius * 1.32,
  pitch: config.visual.wristRadius * 1.28,
});
// Shared primitive dimensions for the physical arms and collision preflight.
export function linkCollider(config: RobotConfig, index: number) {
  const length = config.links[index];
  const radius = armHalfWidth(config);
  const wrist = wristRadii(config);
  const palmLength = config.toolLength - config.fingerLength;
  const size: [number, number, number] =
    index === 0
      ? [config.visual.jointRadius * 0.7, 0, 0]
      : index < 3
        ? [length - 0.04, radius * 2, radius * 2]
        : index === 3
          ? [length, wrist.roll * 2, wrist.roll * 2]
          : index === 4
            ? [wrist.pitch * 2, wrist.pitch * 2, wrist.pitch * 2]
            : [
                palmLength,
                config.fingerDepth + 0.012,
                config.gap[1] + config.fingerWidth * 2 + 0.009,
              ];
  return {
    kind: index === 0 ? ('sphere' as const) : ('box' as const),
    size,
    x: index === 5 ? length + palmLength / 2 : index === 4 ? 0 : length / 2,
  };
}

export function armPartsCollide(a: number, b: number) {
  return Math.abs(a - b) > 1 && !(a >= 3 && a <= 5 && b >= 3 && b <= 5);
}

export type Pose = {
  x: number;
  y: number;
  z: number;
  gap: number;
  rotation?: { x: number; y: number; z: number; w: number };
};
export const DOWN = new Quaternion().setFromRotationMatrix(
  new Matrix4().makeBasis(new Vector3(0, -1, 0), new Vector3(0, 0, -1), new Vector3(1, 0, 0)),
);
export const orientation = { x: DOWN.x, y: DOWN.y, z: DOWN.z, w: DOWN.w };
function forwardChain(config: RobotConfig, q: number[], allFrames: boolean) {
  const axes = config.axes.map((a) => new Vector3(...(a as [number, number, number])));
  const p = new Vector3(...(config.base as [number, number, number]));
  const r = new Quaternion();
  const frames: { position: Vector3; rotation: Quaternion }[] = [];
  q.forEach((angle, i) => {
    r.multiply(new Quaternion().setFromAxisAngle(axes[i], angle));
    if (allFrames || i === 5) frames.push({ position: p.clone(), rotation: r.clone() });
    p.add(new Vector3(config.links[i], 0, 0).applyQuaternion(r));
  });
  const tcp = frames
    .at(-1)!
    .position.clone()
    .add(new Vector3(config.links[5] + config.toolLength, 0, 0).applyQuaternion(r));
  return { frames, position: tcp, rotation: r.clone() };
}
export function forward(config: RobotConfig, q: number[]) {
  return forwardChain(config, q, true);
}
export function toolPose(config: RobotConfig, q: number[]) {
  const { position, rotation } = forwardChain(config, q, false);
  return { position, rotation };
}

export function tableFrame(environment: import('./config').EnvironmentConfig) {
  const height = environment.tableTop - environment.tableThickness;
  const inset = environment.tableSize / 2 - 0.045;
  const depthInset = environment.tableDepth / 2 - 0.045;
  if (environment.tableSupport === 'sled') {
    const tube = 0.048;
    return [-inset, inset].flatMap((x) => [
      ...[-depthInset, depthInset].map((z) => ({
        size: [tube, height - tube * 2, tube] as [number, number, number],
        position: [x, height / 2, z] as [number, number, number],
      })),
      ...[tube / 2, height - tube / 2].map((y) => ({
        size: [tube, tube, depthInset * 2 + tube] as [number, number, number],
        position: [x, y, 0] as [number, number, number],
      })),
    ]);
  }
  return [-inset, inset].flatMap((x) =>
    [-depthInset, depthInset].map((z) => ({
      size: [0.028, height, 0.028] as [number, number, number],
      position: [x, height / 2, z] as [number, number, number],
    })),
  );
}
