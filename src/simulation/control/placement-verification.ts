import { Quaternion, Vector3 } from 'three';
import { contact } from '../tasks/structures';
import { dimensions } from '../world/objects';
import type { Simulation } from '../world/simulation';
import { PLACEMENT_ALIGNMENT, type Placement } from './teachers/types';

/** Check measured placement pose and motion independently of support and release. */
export function placementPositioned(sim: Simulation, goal: Placement) {
  const body = sim.bodies[goal.object],
    p = body.translation(),
    v = body.linvel(),
    w = body.angvel(),
    support = goal.support,
    target = goal.position;
  const objectSize = Math.min(...dimensions(sim.objects[goal.object].shape)),
    sourceHeight = sim.extent(goal.object) * 2,
    anchor = support === null ? target : sim.bodies[support].translation();
  // A supported object may settle away from the planned center. Use its
  // measured support footprint and target height rather than an exact planned center.
  const locationMatches =
    support === null
      ? Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z) < objectSize * 0.15
      : Math.abs(p.x - anchor.x) <= sim.extent(support, { x: 1, y: 0, z: 0 }) &&
        Math.abs(p.z - anchor.z) <= sim.extent(support, { x: 0, y: 0, z: 1 }) &&
        Math.abs(p.y - target.y) < Math.min(0.006, sourceHeight * 0.1);
  // Placement goals constrain the upright axis, not yaw or symmetric face sign.
  const orientationMatches =
    Math.abs(
      new Vector3(0, 1, 0)
        .applyQuaternion(new Quaternion().copy(body.rotation()).invert())
        .dot(new Vector3(0, 1, 0).applyQuaternion(new Quaternion().copy(goal.rotation).invert())),
    ) > PLACEMENT_ALIGNMENT;
  return (
    locationMatches &&
    orientationMatches &&
    Math.hypot(v.x, v.y, v.z) < 0.025 &&
    Math.hypot(w.x, w.y, w.z) < 0.05
  );
}

/** Verify a released placement against real support and gripper separation. */
export function placementSettled(sim: Simulation, goal: Placement, touching: boolean) {
  return (
    !touching &&
    placementPositioned(sim, goal) &&
    contact(
      sim,
      sim.bodies[goal.object].collider(0),
      goal.support === null ? sim.table : sim.bodies[goal.support].collider(0),
      true,
    )
  );
}
