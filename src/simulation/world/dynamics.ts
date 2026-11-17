import { Quaternion, Vector3 } from 'three';
import { armConfig, bodyRotation, waistPivot } from './body';
import { forward } from './geometry';
import type { RobotConfig } from './config';
import type { Inertial } from './inertials';

type Part = { position: Vector3; rotation: Quaternion; inertial: Inertial };
export type Load = Part & { side: number };

// Static gravity and diagonal joint inertia estimates. Cross-joint, Coriolis and
// contact dynamics remain the responsibility of Rapier, not this planning model.
export function jointLoads(config: RobotConfig, action: readonly number[], load?: Load) {
  const root = bodyRotation(action[0], action[1]),
    pivot = waistPivot(config);
  const transform = (point: Vector3) => point.sub(pivot).applyQuaternion(root).add(pivot);
  const torso = { position: pivot, rotation: root, inertial: config.inertials.torso };
  const chains = [0, 1].map((side) => {
    const frames = forward(
      armConfig(config, side),
      action.slice(2 + side * 7, 8 + side * 7),
    ).frames;
    const parts: Part[] = frames.map((frame, i) => ({
      position: transform(frame.position),
      rotation: frame.rotation.premultiply(root),
      inertial: config.inertials.arms[i],
    }));
    const palm = parts[5];
    const tool = config.links[5] + config.toolLength;
    for (const sign of [-1, 1])
      parts.push({
        position: new Vector3(
          tool - config.fingerLength / 2,
          0,
          (sign * (action[8 + side * 7] + config.fingerWidth)) / 2,
        )
          .applyQuaternion(palm.rotation)
          .add(palm.position),
        rotation: palm.rotation,
        inertial: config.inertials.finger,
      });
    if (load?.side === side)
      parts.push({
        position: load.position
          .clone()
          .add(new Vector3(tool, 0, 0))
          .applyQuaternion(palm.rotation)
          .add(palm.position),
        rotation: palm.rotation.clone().multiply(load.rotation),
        inertial: load.inertial,
      });
    return parts;
  });
  function estimate(origin: Vector3, axis: Vector3, parts: Part[]) {
    let gravity = 0,
      inertia = 0;
    for (const part of parts) {
      const offset = new Vector3(...(part.inertial.centerOfMass as [number, number, number]))
        .applyQuaternion(part.rotation)
        .add(part.position)
        .sub(origin);
      gravity += axis.dot(offset.clone().cross(new Vector3(0, part.inertial.mass * 9.81, 0)));
      const frame = part.rotation
        .clone()
        .multiply(
          new Quaternion(...(part.inertial.inertiaFrame as [number, number, number, number])),
        );
      const direction = axis.clone().applyQuaternion(frame.invert());
      const moments = part.inertial.principalInertia;
      inertia +=
        moments[0] * direction.x ** 2 +
        moments[1] * direction.y ** 2 +
        moments[2] * direction.z ** 2 +
        part.inertial.mass * offset.cross(axis).lengthSq();
    }
    return { gravity, inertia };
  }
  const all = [torso, ...chains.flat()];
  return [
    estimate(pivot, new Vector3(0, 1, 0), [
      ...all,
      {
        position: pivot,
        rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), action[0]),
        inertial: config.inertials.yaw,
      },
    ]),
    estimate(pivot, new Vector3(1, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), action[0]), all),
    ...chains.flatMap((parts) =>
      parts
        .slice(0, 6)
        .map((part, i) =>
          estimate(
            part.position,
            new Vector3(...(config.axes[i] as [number, number, number])).applyQuaternion(
              i === 0 ? root : parts[i - 1].rotation,
            ),
            parts.slice(i),
          ),
        ),
    ),
  ];
}
