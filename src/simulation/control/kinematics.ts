import { Quaternion, Vector3 } from 'three';
import { mountShapes, outsideMount } from '../world/mount';
import {
  armHalfWidth,
  forward as fk,
  toolPose as fkToolPose,
  DOWN,
  type Pose,
} from '../world/geometry';
import type { EnvironmentConfig } from '../world/config';
const IK_POSITION_TOLERANCE = 0.000001;
const IK_ROTATION_TOLERANCE = 0.005;
export function kinematics(
  environment: EnvironmentConfig,
  root?: { position: Vector3; rotation: Quaternion },
) {
  const config = environment.robot;
  const shoulder = new Vector3(...(config.base as [number, number, number]));
  if (root) shoulder.applyQuaternion(root.rotation).add(root.position);
  const toolOffset = config.links[5] + config.toolLength;
  // The last joint origin lies within the preceding links' total length. Include
  // the solver's position/orientation tolerances so this only rejects unreachable poses.
  const wristReach =
    config.links.slice(0, 5).reduce((sum, length) => sum + Math.abs(length), 0) +
    Math.abs(toolOffset) * IK_ROTATION_TOLERANCE +
    IK_POSITION_TOLERANCE +
    1e-12;
  const forward = (q: number[]) => {
    const result = fk(config, q);
    if (root) {
      for (const frame of result.frames) {
        frame.position.applyQuaternion(root.rotation).add(root.position);
        frame.rotation.premultiply(root.rotation);
      }
      result.position.applyQuaternion(root.rotation).add(root.position);
      result.rotation.premultiply(root.rotation);
    }
    return result;
  };
  const toolPose = (q: number[]) => {
    const result = fkToolPose(config, q);
    if (root) {
      result.position.applyQuaternion(root.rotation).add(root.position);
      result.rotation.premultiply(root.rotation);
    }
    return result;
  };
  function rotationError(target: Quaternion, actual: Quaternion) {
    const d = target.clone().multiply(actual.clone().invert()).normalize();
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    const n = Math.hypot(d.x, d.y, d.z);
    return n < 1e-10 ? [0, 0, 0] : [d.x, d.y, d.z].map((v) => (v * 2 * Math.atan2(n, d.w)) / n);
  }

  function solve(a: number[][], b: number[]) {
    const m = a.map((row, i) => [...row, b[i]]);
    for (let k = 0; k < 6; k++) {
      let pivot = k;
      for (let i = k + 1; i < 6; i++) if (Math.abs(m[i][k]) > Math.abs(m[pivot][k])) pivot = i;
      [m[k], m[pivot]] = [m[pivot], m[k]];
      const d = m[k][k];
      for (let j = k; j < 7; j++) m[k][j] /= d;
      for (let i = 0; i < 6; i++)
        if (i !== k) {
          const f = m[i][k];
          for (let j = k; j < 7; j++) m[i][j] -= f * m[k][j];
        }
    }
    return m.map((row) => row[6]);
  }

  function inverse(
    position: { x: number; y: number; z: number },
    initial: number[],
    rotation = DOWN,
  ) {
    const q = [...initial];
    const target = new Vector3(position.x, position.y, position.z);
    const wrist = target.clone().sub(new Vector3(toolOffset, 0, 0).applyQuaternion(rotation));
    if (wrist.distanceTo(shoulder) > wristReach) return null;
    for (let iteration = 0; iteration < (config.body ? 160 : 100); iteration++) {
      // IK only uses the tool pose; avoid materializing and transforming unused link frames.
      const f = toolPose(q);
      const dp = target.clone().sub(f.position);
      const dr = rotationError(rotation, f.rotation);
      // Resolve positions more tightly than the static-clearance boundary tolerance.
      if (dp.length() < IK_POSITION_TOLERANCE && Math.hypot(...dr) < IK_ROTATION_TOLERANCE)
        return q;
      const error = [...dp.toArray(), ...dr];
      const j = Array.from({ length: 6 }, () => Array(6).fill(0) as number[]);
      for (let k = 0; k < 6; k++) {
        const perturbed = [...q];
        perturbed[k] += 1e-5;
        const next = toolPose(perturbed);
        const derivative = [
          ...next.position.sub(f.position).multiplyScalar(1e5).toArray(),
          ...rotationError(next.rotation, f.rotation).map((v) => v * 1e5),
        ];
        derivative.forEach((value, row) => {
          j[row][k] = value;
        });
      }
      const a = j.map((row) => j.map((other) => row.reduce((sum, v, i) => sum + v * other[i], 0)));
      a.forEach((row, i) => {
        row[i] += config.body ? 0.0003 : 0.001;
      });
      const y = solve(a, error);
      q.forEach((v, k) => {
        q[k] = Math.max(
          config.limits[k][0],
          Math.min(
            config.limits[k][1],
            v +
              Math.max(
                -0.15,
                Math.min(
                  0.15,
                  j.reduce((sum, row, i) => sum + row[k] * y[i], 0),
                ),
              ),
          ),
        );
      });
    }
    return null;
  }

  const HOME_JOINTS = config.homeJoints;

  // Arm samples keep the physical half-width from the table and mount; the tool keeps the 6 mm
  // grasp clearance so a block center above the table is reachable.
  const ARM_MARGIN = armHalfWidth(config);
  const TOOL_MARGIN = 0.006;

  const mount = mountShapes(config);
  if (root)
    for (const shape of mount)
      if (shape.position.y > config.mount.column.bottom) {
        shape.position.applyQuaternion(root.rotation).add(root.position);
        shape.rotation.premultiply(root.rotation);
      }
  const standClear = (x: number, y: number, z: number) =>
    outsideMount(new Vector3(x, y, z), mount, ARM_MARGIN);

  function staticClearance(q: number[]) {
    const { frames } = forward(q);
    // Sample every collision-bearing link and the tool against the table and mount.
    for (let i = 1; i < 6; i++) {
      const frame = frames[i];
      const end = i === 5 ? config.links[i] + config.toolLength : config.links[i];
      const margin =
        i === 5
          ? TOOL_MARGIN
          : config.body && i >= 3
            ? config.visual.wristRadius * 0.75
            : ARM_MARGIN;
      for (let k = 0; k <= 12; k++) {
        const p = new Vector3(Math.max(0.04, (end * k) / 12), 0, 0)
          .applyQuaternion(frame.rotation)
          .add(frame.position);
        if (
          Math.abs(p.x) < environment.tableSize / 2 + margin &&
          Math.abs(p.z) < environment.tableDepth / 2 + margin &&
          p.y < environment.tableTop + margin - 1e-6
        )
          return false;
        if (!standClear(p.x, p.y, p.z)) return false;
      }
    }
    return true;
  }

  function clearPath(
    points: {
      x: number;
      y: number;
      z: number;
      rotation?: { x: number; y: number; z: number; w: number };
    }[],
    initial = HOME_JOINTS,
    clearance?: (q: number[], pointIndex: number) => boolean,
  ) {
    let q = [...initial];
    let previous = forward(q).position;
    for (const [pointIndex, point] of points.entries()) {
      const end = new Vector3(point.x, point.y, point.z);
      const steps = Math.max(1, Math.ceil(previous.distanceTo(end) / 0.03));
      const startRotation = forward(q).rotation;
      for (let i = 1; i <= steps; i++) {
        const targetRotation = point.rotation
          ? new Quaternion(point.rotation.x, point.rotation.y, point.rotation.z, point.rotation.w)
          : DOWN;
        const rotation = startRotation.clone().slerp(targetRotation, i / steps);
        const next = inverse(previous.clone().lerp(end, i / steps), q, rotation);
        if (!next || !staticClearance(next) || (clearance && !clearance(next, pointIndex)))
          return false;
        q = next;
      }
      previous = end;
    }
    return true;
  }

  // Finger compliance moves the measured TCP relative to the nominal flange model.
  function toolTarget(current: number[], target: Pose, actual: Pose): Pose {
    const nominal = forward(current).position;
    return {
      ...target,
      x: target.x + nominal.x - actual.x,
      y: target.y + nominal.y - actual.y,
      z: target.z + nominal.z - actual.z,
    };
  }

  return { forward, toolPose, inverse, clearPath, staticClearance, toolTarget };
}
