import { Matrix4, Quaternion, Vector3 } from 'three';
import * as shapes from '../world/shape';
import { armConfig, bodyRotation, waistPivot } from '../world/body';
import { armPartsCollide, linkCollider } from '../world/geometry';
import { halfExtent } from '../world/objects';
import { mountShapes } from '../world/mount';
import { kinematics } from './kinematics';
import { finishPlanning, type PlanningWork } from './planning-work';
import type { Simulation } from '../world/simulation';
import type { Action16D } from '../world/types';
import { jointLoads, type Load } from '../world/dynamics';
import type { Placement } from './teachers/types';

export function bodyKin(sim: Simulation, side: number, waist: number[]) {
  const r = sim.config.environment.robot,
    rotation = bodyRotation(waist[0], waist[1]),
    pivot = waistPivot(r);
  return kinematics(
    { ...sim.config.environment, robot: armConfig(r, side) },
    { rotation, position: pivot.clone().sub(pivot.applyQuaternion(rotation)) },
  );
}
export function graspOrientation(direction: Vector3, closing: Vector3) {
  return new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(direction, closing.clone().cross(direction).normalize(), closing),
  );
}
export type Payload = { side: number; position: Vector3; rotation: Quaternion };
export function bodyClear(
  sim: Simulation,
  action: number[],
  source: number,
  payload?: Payload,
  graspSide = payload?.side,
  placement?: Placement,
) {
  const r = sim.config.environment.robot,
    waist = action.slice(0, 2);
  const pivot = waistPivot(r),
    root = bodyRotation(waist[0], waist[1]);
  const mount = mountShapes(r).map((desc) => {
    const [x, y, z] = desc.size;
    const shape =
      desc.kind === 'box'
        ? new shapes.Cuboid(x / 2, y / 2, z / 2)
        : desc.kind === 'sphere'
          ? new shapes.Ball(x)
          : new shapes.Cylinder(y / 2, x);
    if (desc.position.y > pivot.y) {
      desc.position.sub(pivot).applyQuaternion(root).add(pivot);
      desc.rotation.premultiply(root);
    }
    return { ...desc, shape };
  });
  const all: {
    shape: shapes.Shape;
    position: Vector3;
    rotation: Quaternion;
    side: number;
    link: number;
  }[] = [];
  for (const side of [0, 1]) {
    const offset = 2 + side * 7,
      q = action.slice(offset, offset + 6),
      kin = bodyKin(sim, side, waist);
    const fk = kin.forward(q);
    for (let i = 0; i < 8; i++) {
      const finger = i >= 6,
        frame = fk.frames[finger ? 5 : i],
        desc = linkCollider(r, finger ? 5 : i);
      const size = finger ? [r.fingerLength, r.fingerDepth, r.fingerWidth] : desc.size;
      const shape =
        !finger && desc.kind === 'sphere'
          ? new shapes.Ball(size[0])
          : new shapes.Cuboid(size[0] / 2, size[1] / 2, size[2] / 2);
      const position = new Vector3(
        finger ? r.links[5] + r.toolLength - r.fingerLength / 2 : desc.x,
        0,
        finger ? ((i === 6 ? -1 : 1) * (action[offset + 6] + r.fingerWidth)) / 2 : 0,
      )
        .applyQuaternion(frame.rotation)
        .add(frame.position);
      if (sim.table.intersectsShape(shape, position, frame.rotation)) return false;
      if (
        i > 0 &&
        mount.some((m) => {
          const hit = shape.contactShape(
            position,
            frame.rotation,
            m.shape,
            m.position,
            m.rotation,
            0.002,
          );
          return hit !== null && hit.distance <= 0.002;
        })
      )
        return false;
      if (
        sim.bodies.some((b, id) => {
          const eligible =
            !(payload && id === source) &&
            (id !== source ||
              side !== graspSide ||
              i < 6 ||
              action[offset + 6] >
                2 *
                  halfExtent(
                    sim.objects[id].shape,
                    placement?.object === id ? placement.rotation : b.rotation(),
                    new Vector3(0, 0, 1).applyQuaternion(frame.rotation),
                  ) +
                  0.004);
          if (!eligible) return false;
          const hit = shape.contactShape(
            position,
            frame.rotation,
            b.collider(0).shape,
            placement?.object === id ? placement.position : b.translation(),
            placement?.object === id ? placement.rotation : b.rotation(),
            0.004,
          );
          return hit !== null && hit.distance <= 0.004;
        })
      )
        return false;
      all.push({ shape, position, rotation: frame.rotation, side, link: finger ? 6 : i });
    }
  }
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i],
        b = all[j];
      if (a.side === b.side && !armPartsCollide(a.link, b.link)) continue;
      const hit = a.shape.contactShape(
        a.position,
        a.rotation,
        b.shape,
        b.position,
        b.rotation,
        0.002,
      );
      if (hit !== null && hit.distance <= 0.002) return false;
    }
  if (payload) {
    const body = sim.bodies[source],
      shape = body.collider(0).shape;
    const kin = bodyKin(sim, payload.side, waist);
    const tool = kin.forward(action.slice(2 + payload.side * 7, 8 + payload.side * 7));
    const p = payload.position.clone().applyQuaternion(tool.rotation).add(tool.position),
      rotation = tool.rotation.clone().multiply(payload.rotation);
    const obstacles = [
      ...mount,
      ...all.filter((part) => part.side !== payload.side || part.link < 6),
      ...[sim.table, ...sim.bodies.filter((_, i) => i !== source).map((b) => b.collider(0))].map(
        (c) => ({ shape: c.shape, position: c.translation(), rotation: c.rotation() }),
      ),
    ];
    for (const obstacle of obstacles) {
      const hit = shape.contactShape(
        p,
        rotation,
        obstacle.shape,
        obstacle.position,
        obstacle.rotation,
        0,
      );
      if (hit && hit.distance < -0.0015) return false;
    }
  }
  return true;
}
export type Path = { samples: Action16D[]; duration: number; knots: number[]; feasible: boolean };
export function payloadClear(sim: Simulation, path: Path, object: number, payload: Payload) {
  return pathClear(sim, path, object, payload);
}
export function jointPath(...args: Parameters<typeof jointPathSteps>): Path | null {
  return finishPlanning(jointPathSteps(...args));
}
export function* jointPathSteps(
  sim: Simulation,
  from: Action16D,
  to: Action16D,
  source: number,
): PlanningWork<Path | null> {
  const steps = 30,
    samples: Action16D[] = [];
  for (let i = 0; i <= steps; i++) {
    yield;
    const q = from.map((v, j) => v + ((to[j] - v) * i) / steps) as Action16D;
    if (!bodyClear(sim, q, source)) return null;
    samples.push(q);
  }
  const path = timePath(sim, samples);
  return (yield* pathClearSteps(sim, path, source)) ? path : null;
}
// Shared slopes and zero knot accelerations make each quintic segment C2.
function tangent(path: Pick<Path, 'samples' | 'knots'>, at: number, joint: number) {
  if (at === 0 || at === path.samples.length - 1) return 0;
  const leftTime = path.knots[at] - path.knots[at - 1],
    rightTime = path.knots[at + 1] - path.knots[at];
  const left = (path.samples[at][joint] - path.samples[at - 1][joint]) / leftTime,
    right = (path.samples[at + 1][joint] - path.samples[at][joint]) / rightTime;
  if (left * right <= 0) return 0;
  const a = 2 * rightTime + leftTime,
    b = rightTime + 2 * leftTime;
  const harmonic = (a + b) / (a / left + b / right);
  return (
    Math.sign(harmonic) *
    Math.min(Math.abs(harmonic), 1.25 * Math.min(Math.abs(left), Math.abs(right)))
  );
}

function coefficients(path: Pick<Path, 'samples' | 'knots'>, segment: number, joint: number) {
  const h = path.knots[segment + 1] - path.knots[segment],
    delta = path.samples[segment + 1][joint] - path.samples[segment][joint],
    start = tangent(path, segment, joint),
    end = tangent(path, segment + 1, joint);
  return {
    h,
    a: 6 * delta - 3 * h * (start + end),
    b: -15 * delta + h * (8 * start + 7 * end),
    c: h * start,
    d: 10 * delta - h * (6 * start + 4 * end),
    control: [
      0,
      (h * start) / 5,
      (2 * h * start) / 5,
      delta - (2 * h * end) / 5,
      delta - (h * end) / 5,
      delta,
    ],
  };
}

function derivativeBound(values: number[], subdivisions = 2): number {
  if (subdivisions === 0) return Math.max(...values.map(Math.abs));
  const left = [values[0]],
    right = [values.at(-1)!];
  let row = values;
  while (row.length > 1) {
    row = row.slice(1).map((value, i) => (row[i] + value) / 2);
    left.push(row[0]);
    right.unshift(row.at(-1)!);
  }
  return Math.max(
    derivativeBound(left, subdivisions - 1),
    derivativeBound(right, subdivisions - 1),
  );
}

export function timePath(
  sim: Simulation,
  input: Action16D[],
  payload?: Payload,
  source?: number,
): Path {
  const r = sim.config.environment.robot;
  let load: Load | undefined;
  if (payload) {
    const body = sim.bodies[source!];
    load = {
      ...payload,
      inertial: {
        mass: body.mass(),
        centerOfMass: Object.values(body.localCom()),
        principalInertia: Object.values(body.principalInertia()),
        inertiaFrame: Object.values(body.principalInertiaLocalFrame()),
      },
    };
  }
  const distinct = input.filter(
    (q, i) => i === 0 || q.some((v, j) => Math.abs(v - input[i - 1][j]) > 1e-10),
  );
  const samples: Action16D[] = [];
  for (const point of distinct) {
    while (samples.length >= 2) {
      const first = samples.at(-2)!,
        middle = samples.at(-1)!,
        delta = point.map((v, j) => v - first[j]);
      const axis = delta.reduce(
        (best, v, j) => (Math.abs(v) > Math.abs(delta[best]) ? j : best),
        0,
      );
      if (Math.abs(delta[axis]) < 1e-10) break;
      const ratio = (middle[axis] - first[axis]) / delta[axis];
      if (
        ratio < 0 ||
        ratio > 1 ||
        middle.some((v, j) => Math.abs(v - first[j] - ratio * delta[j]) > 1e-10)
      )
        break;
      // Subdividing an unchanged straight joint path must not introduce more braking points.
      samples.pop();
    }
    samples.push(point);
  }
  if (samples.length === 1) samples.push(samples[0]);
  const limits = [...r.body.motor.maxTorque, ...r.armMotor.maxTorque, ...r.armMotor.maxTorque];
  const loads = samples.map((point) => jointLoads(r, point, load));
  const feasible = loads.every((row) =>
    row.every((joint, i) => Math.abs(joint.gravity) < limits[i]),
  );
  const acceleration = samples[0].map((_, j) => {
    if (j === 8 || j === 15) return Infinity;
    const axis = j > 8 ? j - 1 : j;
    const nominal = j < 2 ? r.body.acceleration : r.jointAcceleration * 0.65;
    // Reserve 30% of remaining torque for tracking and unmodeled coupling.
    return Math.min(
      nominal,
      ...loads.map(
        (row) =>
          (0.7 * Math.max(0, limits[axis] - Math.abs(row[axis].gravity))) / row[axis].inertia,
      ),
    );
  });
  const speed = samples[0].map((_, i) =>
    i === 8 || i === 15 ? r.speed.gap : i < 2 ? r.body.speed : r.jointSpeed * 0.65,
  );
  const knots = [0];
  for (let i = 1; i < samples.length; i++) {
    const interval = Math.max(
      0.005,
      ...samples[i].map((v, j) => Math.abs(v - samples[i - 1][j]) / speed[j]),
    );
    knots.push(knots.at(-1)! + interval);
  }
  // Bezier derivative control points bound the entire segment, including jerk.
  const curve = { samples, knots };
  const factors = () =>
    samples.slice(1).map((_, i) => {
      let scale = 1;
      for (let j = 0; j < samples[i].length; j++) {
        const { h, control } = coefficients(curve, i, j);
        const derivative = (values: number[]) =>
          values.slice(1).map((v, k) => ((values.length - 1) * (v - values[k])) / h);
        const velocities = derivative(control),
          accelerations = derivative(velocities),
          jerks = derivative(accelerations);
        const velocity = derivativeBound(velocities);
        scale = Math.max(scale, velocity / speed[j]);
        if (j !== 8 && j !== 15) {
          const limit = acceleration[j];
          const jerkLimit = j < 2 ? r.body.jerk : r.jointJerk * 0.65;
          if (limit > 0) scale = Math.max(scale, Math.sqrt(derivativeBound(accelerations) / limit));
          scale = Math.max(scale, Math.cbrt(derivativeBound(jerks) / jerkLimit));
        }
      }
      return scale;
    });
  // Stretch constrained intervals locally so one sharp corner does not slow the entire carry.
  // Changing knot spacing changes neighboring tangents. Let interval corrections
  // propagate along the whole path before applying the proven residual bound.
  for (let pass = 0; pass < samples.length; pass++) {
    const scales = factors();
    if (Math.max(...scales) <= 1.001) break;
    const intervals = scales.map((scale, i) => scale * (knots[i + 1] - knots[i]));
    for (let i = 0; i < intervals.length; i++) knots[i + 1] = knots[i] + intervals[i];
  }
  const scale = Math.max(...factors());
  const total = knots.at(-1)!;
  return {
    samples,
    knots: knots.map((t) => t / total),
    duration: Math.max(0.45, total * scale),
    feasible,
  };
}

function simplifyPath(samples: Action16D[]) {
  const keep = new Set([0, samples.length - 1]);
  const visit = (first: number, last: number) => {
    if (last - first < 2) return;
    const from = samples[first],
      delta = samples[last].map((value, joint) => value - from[joint]),
      length = delta.reduce((sum, value) => sum + value * value, 0);
    let error = 0.002,
      split = -1;
    for (let i = first + 1; i < last; i++) {
      const ratio =
        length === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                1,
                samples[i].reduce(
                  (sum, value, joint) => sum + (value - from[joint]) * delta[joint],
                  0,
                ) / length,
              ),
            );
      const distance = Math.max(
        ...samples[i].map(
          (value, joint) =>
            Math.abs(value - from[joint] - ratio * delta[joint]) *
            (joint === 8 || joint === 15 ? 10 : 1),
        ),
      );
      if (distance > error) {
        error = distance;
        split = i;
      }
    }
    if (split !== -1) {
      keep.add(split);
      visit(first, split);
      visit(split, last);
    }
  };
  visit(0, samples.length - 1);
  return samples.filter((_, i) => keep.has(i));
}

export function cartesianPath(...args: Parameters<typeof cartesianPathSteps>): Path | null {
  return finishPlanning(cartesianPathSteps(...args));
}
export function* cartesianPathSteps(
  sim: Simulation,
  from: Action16D,
  side: number,
  points: Vector3[],
  rotation: Quaternion,
  gap: number,
  source: number,
  payload?: Payload,
  placement?: Placement,
): PlanningWork<Path | null> {
  const kin = bodyKin(sim, side, from.slice(0, 2)),
    offset = 2 + side * 7;
  let state = [...from] as Action16D,
    pose = kin.forward(state.slice(offset, offset + 6));
  const samples = [state];
  for (const end of points) {
    const start = pose.position.clone(),
      initial = pose.rotation.clone();
    const steps = Math.max(
      2,
      Math.ceil(start.distanceTo(end) / 0.012),
      Math.ceil(initial.angleTo(rotation) / 0.08),
    );
    for (let i = 1; i <= steps; i++) {
      yield;
      const t = i / steps;
      const q = kin.inverse(
        start.clone().lerp(end, t),
        state.slice(offset, offset + 6),
        initial.clone().slerp(rotation, Math.min(1, t * 1.5)),
      );
      if (!q || q.some((v, j) => Math.abs(v - state[offset + j]) > 0.4)) return null;
      state = [...state] as Action16D;
      state.splice(offset, 7, ...q, gap);
      if (!bodyClear(sim, state, source, payload, side, placement)) return null;
      samples.push(state);
    }
    pose = kin.forward(state.slice(offset, offset + 6));
  }
  const simplified = simplifyPath(samples);
  const path = timePath(sim, simplified, payload, source);
  if (yield* pathClearSteps(sim, path, source, payload, side, placement)) return path;
  // A shortcut may cut a corner near an obstacle; the dense route is another motion candidate.
  if (simplified.length === samples.length) return null;
  const dense = timePath(sim, samples, payload, source);
  return (yield* pathClearSteps(sim, dense, source, payload, side, placement)) ? dense : null;
}
export function samplePath(path: Path, seconds: number): Action16D {
  const t = Math.min(1, Math.max(0, seconds / path.duration));
  if (t === 0) return [...path.samples[0]] as Action16D;
  if (t === 1) return [...path.samples.at(-1)!] as Action16D;
  let low = 0,
    high = path.knots.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (path.knots[middle] <= t) low = middle;
    else high = middle;
  }
  const u = (t - path.knots[low]) / (path.knots[low + 1] - path.knots[low]);
  return path.samples[low].map((start, j) => {
    const { a, b, c, d } = coefficients(path, low, j),
      end = path.samples[low + 1][j];
    const value = start + u * c + u ** 3 * (d + u * (b + u * a));
    return Math.max(Math.min(start, end), Math.min(Math.max(start, end), value));
  }) as Action16D;
}

export function pathClear(...args: Parameters<typeof pathClearSteps>): boolean {
  return finishPlanning(pathClearSteps(...args));
}
export function* pathClearSteps(
  sim: Simulation,
  path: Path,
  source: number,
  payload?: Payload,
  graspSide = payload?.side,
  placement?: Placement,
): PlanningWork<boolean> {
  if (!path.feasible) return false;
  for (let i = 0; i < path.samples.length - 1; i++) {
    const steps = Math.max(
      2,
      Math.ceil(
        Math.max(
          ...path.samples[i].map(
            (v, j) => (j === 8 || j === 15 ? 10 : 1) * Math.abs(path.samples[i + 1][j] - v),
          ),
        ) / 0.025,
      ),
    );
    for (let k = 0; k <= steps; k++) {
      yield;
      const t = path.knots[i] + ((path.knots[i + 1] - path.knots[i]) * k) / steps;
      if (
        !bodyClear(sim, samplePath(path, t * path.duration), source, payload, graspSide, placement)
      )
        return false;
    }
  }
  return true;
}
