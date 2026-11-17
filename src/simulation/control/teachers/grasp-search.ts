import type { TeacherContext } from './types';
import type { PlacementCandidate } from './whole-body-types';

import { Quaternion, Vector3 } from 'three';
import type { Simulation } from '../../world/simulation';
import type { Action16D } from '../../world/types';
import { dimensions, halfExtent } from '../../world/objects';
import { wristRadii } from '../../world/geometry';
import {
  bodyKin,
  bodyClear,
  cartesianPathSteps,
  graspOrientation,
  jointPathSteps,
  timePath,
  pathClearSteps,
  type Path,
  type Payload,
} from '../body-planning';

import { type PlanningWork } from '../planning-work';

type Grasp = { kind: 'side' | 'oblique' | 'top'; direction: Vector3; rotation: Quaternion };
export type Plan = {
  goal: PlacementCandidate;
  width: number;
  arm: number;
  object: number;
  waist: number[];
  grasp: Grasp;
  grip: Vector3;
  destination: Vector3;
  ready: Path;
  pickup: Path[];
  approach?: Path;
  rest: Action16D;
  insert: Path;
  cost: number;
};
type Pickup = Pick<Plan, 'ready' | 'approach' | 'rest' | 'insert' | 'pickup'> & {
  payload: Payload;
};
type PickupResult = Pickup | 'approach' | 'insert';
export type GraspSearch = {
  solutions: Map<string, number[] | null>;
  pickups: Map<string, PickupResult>;
};
export const vector = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z);

export function graspKey(object: number, arm: number, grasp: Grasp) {
  return [object, arm, ...grasp.direction.toArray().map((v) => v.toFixed(2))].join(':');
}
function candidateGrasps(): Grasp[] {
  const out: Grasp[] = [];
  for (const degrees of [35, 0, 90, 55, 20])
    for (const heading of degrees === 90 ? [0, Math.PI / 2] : [0, -Math.PI / 2, Math.PI / 2]) {
      const a = (degrees * Math.PI) / 180;
      const direction = new Vector3(
        Math.sin(heading) * Math.cos(a),
        -Math.sin(a),
        Math.cos(heading) * Math.cos(a),
      );
      const closing = new Vector3(Math.cos(heading), 0, -Math.sin(heading));
      out.push({
        kind: degrees === 0 ? 'side' : degrees === 90 ? 'top' : 'oblique',
        direction,
        rotation: graspOrientation(direction, closing),
      });
    }
  return out;
}
export function* choosePlan(
  sim: Simulation,
  settings: TeacherContext['teacher'],
  previousWaistDelta: number[],
  rejectedGrasps: ReadonlySet<string>,
  rejected: { ik: number; ready: number; approach: number; insert: number },
  goals: PlacementCandidate[],
  search: GraspSearch,
  allowTransfer = false,
): PlanningWork<Plan | null> {
  const r = sim.config.environment.robot,
    policy = settings.policy;
  const current = sim.targetState() as Action16D;
  // Every pickup starts with a joint path that must clear this complete pose.
  if (!bodyClear(sim, current, -1)) return null;
  // Posture and travel bound the search; feasible candidates are ranked by motion seconds.
  const preferenceWindow = 0.1;
  let bestPreference = Infinity;
  const plans: { plan: Plan; preference: number; place: Path }[] = [];
  const { solutions, pickups } = search;
  const grasps = candidateGrasps();
  for (const goal of goals) {
    const object = goal.object,
      source = vector(sim.bodies[object].translation());
    const destination = vector(goal.position);
    destination.y -= 0.0008;
    const preferredPitch = Math.max(
      0,
      Math.min(r.body.pitchLimit, (Math.max(source.z, destination.z) + 0.25) * 1.1),
    );
    const poses = [
      [current[0], current[1]],
      [0, 0],
      [0, preferredPitch],
      ...[0, 0.15, 0.25, 0.4, 0.5].flatMap((pitch) =>
        [current[0], 0, -0.2, 0.2, -0.35, 0.35, -0.6, 0.6].map((yaw) => [yaw, pitch]),
      ),
    ].filter(
      ([yaw, pitch], i, all) =>
        Math.abs(yaw) <= r.body.yawLimit &&
        pitch <= r.body.pitchLimit &&
        all.findIndex((p) => p[0] === yaw && p[1] === pitch) === i,
    );
    const waistCost = (waist: number[]) =>
      waist.reduce((sum, v, i) => {
        const delta = v - current[i];
        return (
          sum +
          policy.waistTravel * Math.abs(delta) +
          policy.waistPosture * Math.abs(v) +
          (delta * previousWaistDelta[i] < -0.0025 ? policy.waistReversal * Math.abs(delta) : 0)
        );
      }, 0);
    poses.sort((a, b) => waistCost(a) - waistCost(b));
    for (const waist of poses) {
      const lowerBound =
        waistCost(waist) + source.distanceTo(destination) - policy.taskValue * goal.value;
      if (lowerBound > bestPreference + preferenceWindow) continue;
      for (const arm of [source.x <= 0 ? 0 : 1, source.x <= 0 ? 1 : 0]) {
        const offset = 2 + arm * 7,
          initial = current.slice(offset, offset + 6),
          kin = bodyKin(sim, arm, waist);
        for (const grasp of grasps) {
          yield;
          if (rejectedGrasps.has(graspKey(object, arm, grasp))) continue;
          const graspCost =
            grasp.kind === 'top' ? policy.topGrasp : grasp.kind === 'side' ? policy.sideGrasp : 0;
          // Joint effort is nonnegative, so these grasps cannot improve the incumbent.
          if (lowerBound + graspCost > bestPreference + preferenceWindow) continue;
          const closing = new Vector3(0, 0, 1).applyQuaternion(grasp.rotation);
          const width =
            2 * halfExtent(sim.objects[object].shape, sim.bodies[object].rotation(), closing);
          if (width + 0.012 > r.gap[1] || width < r.gap[0] + 0.002) continue;
          const depth = Math.min(
            0.04,
            sim.extent(object, grasp.direction) * (grasp.kind === 'top' ? 0.72 : 1.28),
          );
          const grip = source.clone().addScaledVector(grasp.direction, depth);
          grip.y = Math.max(
            sim.config.environment.tableTop + (grasp.kind === 'top' ? 0.006 : 0.012),
            grip.y,
          );
          if (grasp.kind === 'side')
            grip.y = Math.max(
              grip.y,
              sim.config.environment.tableTop + Math.max(...Object.values(wristRadii(r))) + 0.004,
            );
          const key = [object, arm, ...waist, ...grasp.direction.toArray()].join(':');
          if (!solutions.has(key))
            solutions.set(
              key,
              kin.inverse(grip, initial, grasp.rotation) ??
                kin.inverse(grip, r.homeJoints, grasp.rotation),
            );
          const q = solutions.get(key)!;
          if (!q) {
            rejected.ik++;
            continue;
          }
          const effort = q.reduce(
            (sum, v, i) =>
              sum + Math.abs(v - initial[i]) * (i >= 3 ? policy.wristTravel : policy.armTravel),
            0,
          );
          const preference = lowerBound + effort + graspCost;
          if (preference > bestPreference + preferenceWindow) continue;
          let pickup = pickups.get(key);
          if (pickup === undefined) {
            pickup = yield* preparePickup(sim, current, waist, arm, object, grasp, grip, width, q);
            pickups.set(key, pickup);
          }
          if (typeof pickup === 'string') {
            rejected[pickup]++;
            continue;
          }
          const transfer = yield* transport(
            sim,
            settings,
            pickup.insert.samples.at(-1)!,
            arm,
            grasp,
            destination,
            pickup.payload,
            width,
            object,
            new Quaternion().copy(goal.rotation),
            allowTransfer,
          );
          if (!transfer) continue;
          bestPreference = Math.min(bestPreference, preference);
          const cost =
            pickup.pickup.reduce((sum, path) => sum + path.duration, 0) +
            transfer.carry.duration +
            transfer.place.duration;
          const plan: Plan = {
            goal,
            width,
            arm,
            object,
            waist,
            grasp,
            grip,
            destination,
            ready: pickup.ready,
            pickup: pickup.pickup,
            rest: pickup.rest,
            approach: pickup.approach,
            insert: pickup.insert,
            cost,
          };
          plans.push({ plan, preference, place: transfer.place });
        }
      }
    }
  }
  const candidates = plans
    .filter(({ preference }) => preference <= bestPreference + preferenceWindow)
    .sort((a, b) => a.plan.cost - b.plan.cost || a.preference - b.preference);
  let best: Plan | null = null;
  // Bound release lookahead to the three fastest nominal motions.
  for (const { plan, place } of candidates.slice(0, 3)) {
    // Remaining candidates cannot improve once their motion-only lower bound exceeds the full cost.
    if (best && plan.cost >= best.cost) break;
    const cost = plan.cost + (yield* releaseCost(sim, plan, place));
    if (!best || cost < best.cost) best = { ...plan, cost };
  }
  return best;
}
function* releaseCost(sim: Simulation, plan: Plan, place: Path): PlanningWork<number> {
  const r = sim.config.environment.robot,
    open = [...place.samples.at(-1)!] as Action16D;
  open[8 + plan.arm * 7] = Math.min(r.gap[1], plan.width + 0.025);
  const pose = bodyKin(sim, plan.arm, open.slice(0, 2)).forward(
    open.slice(2 + plan.arm * 7, 8 + plan.arm * 7),
  );
  const exit = pose.position
    .clone()
    .add(new Vector3(-r.fingerLength - 0.04, 0, 0).applyQuaternion(pose.rotation));
  const placement = { ...plan.goal, position: plan.destination };
  const withdrawal = yield* cartesianPathSteps(
    sim,
    open,
    plan.arm,
    [exit],
    pose.rotation,
    open[8 + plan.arm * 7],
    -1,
    undefined,
    placement,
  );
  if (withdrawal) return withdrawal.duration;
  const reverse = timePath(
    sim,
    [...place.samples].reverse().map((sample) => {
      const state = [...sample] as Action16D;
      state[8 + plan.arm * 7] = open[8 + plan.arm * 7];
      return state;
    }),
  );
  if (yield* pathClearSteps(sim, reverse, -1, undefined, undefined, placement))
    return reverse.duration;
  // A longer escape may still work. Price its unobstructed return instead of declaring task failure.
  const rest = [...plan.rest] as Action16D;
  rest[8 + plan.arm * 7] = open[8 + plan.arm * 7];
  return reverse.duration + timePath(sim, [open, rest]).duration;
}

function* preparePickup(
  sim: Simulation,
  current: Action16D,
  waist: number[],
  arm: number,
  object: number,
  grasp: Grasp,
  grip: Vector3,
  width: number,
  q: number[],
): PlanningWork<PickupResult> {
  const r = sim.config.environment.robot,
    offset = 2 + arm * 7,
    open = Math.min(r.gap[1], width + 0.025);
  let rejection: 'approach' | 'insert' = 'approach';
  const inactive = 2 + (1 - arm) * 7;
  const foldInactive = current
    .slice(inactive, inactive + 6)
    .some((value, joint) => Math.abs(value - r.homeJoints[joint]) > 0.1);
  for (const [distance, rise] of [
    [0.05, 0.025],
    [0.09, 0.055],
  ]) {
    const pre = grip.clone().addScaledVector(grasp.direction, -distance),
      overhead = pre.clone().add(new Vector3(0, rise, 0));
    const qPre = bodyKin(sim, arm, waist).inverse(overhead, q, grasp.rotation);
    if (!qPre) continue;
    for (const blend of foldInactive ? [0.65, 0] : [0]) {
      const prepared = [...current] as Action16D;
      prepared.splice(0, 2, ...waist);
      prepared[offset + 6] = open;
      // Clear the previous empty hand while the other hand approaches its next object.
      for (let joint = 0; joint < 6; joint++)
        prepared[inactive + joint] += blend * (r.homeJoints[joint] - prepared[inactive + joint]);
      const atPre = [...prepared] as Action16D;
      atPre.splice(offset, 6, ...qPre);
      const combined = yield* jointPathSteps(sim, current, atPre, object);
      const ready = combined ?? (yield* jointPathSteps(sim, current, prepared, object));
      if (!ready) continue;
      const approach = combined ? null : yield* jointPathSteps(sim, prepared, atPre, object);
      if (!combined && !approach) continue;
      const insert = yield* cartesianPathSteps(
        sim,
        atPre,
        arm,
        [pre, grip],
        grasp.rotation,
        open,
        object,
      );
      if (!insert) {
        rejection = 'insert';
        continue;
      }
      const joined = timePath(sim, [
        ...ready.samples,
        ...(approach?.samples.slice(1) ?? []),
        ...insert.samples.slice(1),
      ]);
      const pickup = (yield* pathClearSteps(sim, joined, object, undefined, arm))
        ? [joined]
        : [ready, ...(approach ? [approach] : []), insert];
      const payload: Payload = {
        side: arm,
        position: vector(sim.bodies[object].translation())
          .sub(grip)
          .applyQuaternion(grasp.rotation.clone().invert()),
        rotation: grasp.rotation
          .clone()
          .invert()
          .multiply(new Quaternion().copy(sim.bodies[object].rotation())),
      };
      return { ready, pickup, rest: prepared, approach: approach ?? undefined, insert, payload };
    }
  }
  return rejection;
}
export function* transport(
  sim: Simulation,
  settings: TeacherContext['teacher'],
  from: Action16D,
  arm: number,
  grasp: Grasp,
  destination: Vector3,
  payload: Payload,
  gap: number,
  object: number,
  objectRotation: Quaternion,
  allowTransfer = false,
): PlanningWork<{ carry: Path; place: Path } | null> {
  const kin = bodyKin(sim, arm, from.slice(0, 2));
  let startPose = kin.forward(from.slice(2 + arm * 7, 8 + arm * 7));
  const placementRotation = objectRotation.clone().multiply(payload.rotation.clone().invert());
  let liftBeforeRotation: Path | null = null;
  if (startPose.rotation.angleTo(placementRotation) > 0.08) {
    const height = Math.max(0.09, Math.hypot(...dimensions(sim.objects[object].shape)) / 2 + 0.02);
    liftBeforeRotation = yield* cartesianPathSteps(
      sim,
      from,
      arm,
      [startPose.position.clone().add(new Vector3(0, height, 0))],
      startPose.rotation,
      gap,
      object,
      payload,
    );
    if (!liftBeforeRotation) return null;
    liftBeforeRotation.duration = Math.max(
      liftBeforeRotation.duration,
      (1.875 * height) / settings.transitSpeed,
    );
    from = liftBeforeRotation.samples.at(-1)!;
    startPose = kin.forward(from.slice(2 + arm * 7, 8 + arm * 7));
  }
  const start = startPose.position;
  const end = destination.clone().sub(payload.position.clone().applyQuaternion(placementRotation));
  for (const rise of [0.035, 0.055, 0.085, 0.12]) {
    const pre = end.clone().add(new Vector3(0, rise, 0));
    const a = start.clone().add(new Vector3(0, rise, 0)),
      b = pre.clone();
    b.y = Math.max(start.y, end.y) + rise;
    const points: Vector3[] = [];
    for (let i = 1; i <= 16; i++) {
      const t = i / 16,
        u = 1 - t;
      points.push(
        start
          .clone()
          .multiplyScalar(u * u * u)
          .addScaledVector(a, 3 * u * u * t)
          .addScaledVector(b, 3 * u * t * t)
          .addScaledVector(pre, t * t * t),
      );
    }
    const carry = yield* cartesianPathSteps(
      sim,
      from,
      arm,
      points,
      placementRotation,
      gap,
      object,
      payload,
    );
    if (!carry) continue;
    const place = yield* cartesianPathSteps(
      sim,
      carry.samples.at(-1)!,
      arm,
      [end],
      placementRotation,
      gap,
      object,
      payload,
    );
    // Both Cartesian paths already passed the same interpolated payload collision checks.
    if (place) {
      const distance = [start, ...points].reduce(
        (sum, p, i, points) => (i ? sum + p.distanceTo(points[i - 1]) : sum),
        0,
      );
      carry.duration = Math.max(carry.duration, (1.875 * distance) / settings.transitSpeed);
      place.duration = Math.max(place.duration, (1.875 * rise) / settings.precisionSpeed);
      if (liftBeforeRotation) {
        const joined = timePath(
          sim,
          [...liftBeforeRotation.samples, ...carry.samples.slice(1)],
          payload,
          object,
        );
        joined.duration = Math.max(joined.duration, liftBeforeRotation.duration + carry.duration);
        if (!(yield* pathClearSteps(sim, joined, object, payload))) continue;
        return { carry: joined, place };
      }
      return { carry, place };
    }
  }
  if (allowTransfer) {
    const lift = yield* cartesianPathSteps(
      sim,
      from,
      arm,
      [start.clone().add(new Vector3(0, 0.09, 0))],
      grasp.rotation,
      gap,
      object,
      payload,
    );
    if (!lift) return null;
    lift.duration = Math.max(lift.duration, (1.875 * 0.09) / settings.transitSpeed);
    const lifted = lift.samples.at(-1)!,
      tip = bodyKin(sim, arm, lifted.slice(0, 2)).forward(
        lifted.slice(2 + arm * 7, 8 + arm * 7),
      ).position;
    for (const pitch of [0, 0.15, 0.3])
      for (const yaw of [0, arm === 0 ? 0.35 : -0.35, arm === 0 ? 0.6 : -0.6]) {
        if (
          pitch > sim.config.environment.robot.body.pitchLimit ||
          Math.abs(yaw) > sim.config.environment.robot.body.yawLimit
        )
          continue;
        let state = [...lifted] as Action16D;
        const samples = [state];
        for (let i = 1; i <= 30; i++) {
          yield;
          const waist = [
            lifted[0] + ((yaw - lifted[0]) * i) / 30,
            lifted[1] + ((pitch - lifted[1]) * i) / 30,
          ];
          const q = bodyKin(sim, arm, waist).inverse(
            tip,
            state.slice(2 + arm * 7, 8 + arm * 7),
            grasp.rotation,
          );
          if (!q) break;
          state = [...state] as Action16D;
          state.splice(0, 2, ...waist);
          state.splice(2 + arm * 7, 7, ...q, gap);
          if (!bodyClear(sim, state, object, payload)) break;
          samples.push(state);
        }
        if (samples.length !== 31) continue;
        const turn = timePath(sim, samples, payload, object),
          rest = yield* transport(
            sim,
            settings,
            state,
            arm,
            grasp,
            destination,
            payload,
            gap,
            object,
            objectRotation,
          );
        if (!rest) continue;
        const carry = timePath(
          sim,
          [
            ...(liftBeforeRotation?.samples ?? []),
            ...lift.samples,
            ...turn.samples.slice(1),
            ...rest.carry.samples.slice(1),
          ],
          payload,
          object,
        );
        carry.duration = Math.max(
          carry.duration,
          (liftBeforeRotation?.duration ?? 0) + lift.duration + turn.duration + rest.carry.duration,
        );
        if (!(yield* pathClearSteps(sim, carry, object, payload))) continue;
        return { carry, place: rest.place };
      }
  }
  return null;
}
