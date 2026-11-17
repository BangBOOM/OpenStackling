import type { MeasuredFrame, PhysicsFrame } from './frame';
import type {
  Action,
  ActuatorDiagnostic,
  FingerDiagnostic,
  ContactDiagnostic,
  Vec3,
  Quat,
} from './types';

class Reader {
  at = 0;
  constructor(readonly values: Float64Array) {}
  number() {
    return this.values[this.at++];
  }
  count() {
    const count = this.number();
    if (!Number.isSafeInteger(count) || count < 0 || count > this.values.length - this.at)
      throw new Error('Invalid frame count');
    return count;
  }
  vector(): Vec3 {
    return { x: this.number(), y: this.number(), z: this.number() };
  }
  rotation(): Quat {
    return { ...this.vector(), w: this.number() };
  }
  action() {
    const at = this.at;
    this.at += 16;
    return Array.from(this.values.subarray(at, this.at)) as Action;
  }
  pose() {
    return { ...this.vector(), gap: this.number(), rotation: this.rotation() };
  }
  actuator(): ActuatorDiagnostic {
    return {
      reference: this.number(),
      referenceVelocity: this.number(),
      velocity: this.number(),
      gravityTorque: this.number(),
      requestedTorqueEstimate: this.number(),
      limitedTorqueEstimate: this.number(),
      torqueLimit: this.number(),
      trackingError: this.number(),
      anchorError: this.number(),
    };
  }
  finger(): FingerDiagnostic {
    return {
      position: this.number(),
      velocity: this.number(),
      reference: this.number(),
      referenceVelocity: this.number(),
      requestedForceEstimate: this.number(),
      limitedForceEstimate: this.number(),
    };
  }
  contact(): ContactDiagnostic {
    return {
      normalForce: this.number(),
      frictionLimit: this.number(),
      slipSpeed: this.number(),
      friction: this.number(),
      points: this.number(),
    };
  }
  base() {
    const tick = this.number(),
      bodies = this.count(),
      colliders = this.count(),
      objects = this.count();
    const state = this.action(),
      target = this.action();
    const bodyFrames = Array.from({ length: bodies }, () => ({
      id: this.number(),
      position: this.vector(),
      rotation: this.rotation(),
      velocity: this.vector(),
      angularVelocity: this.vector(),
      worldCom: this.vector(),
    }));
    const colliderFrames = Array.from({ length: colliders }, () => ({
      id: this.number(),
      position: this.vector(),
      rotation: this.rotation(),
    }));
    const tcps = Array.from({ length: 2 }, () => this.pose());
    return { tick, state, target, bodies: bodyFrames, colliders: colliderFrames, tcps, objects };
  }
}

export function readPhysicsFrame(values: Float64Array): PhysicsFrame {
  const r = new Reader(values),
    { objects, ...frame } = r.base();
  const actuators = Array.from({ length: 14 }, () => r.actuator());
  const fingers = Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => r.finger()));
  const contacts = Array.from({ length: 2 }, () =>
    Array.from({ length: objects }, () => Array.from({ length: 2 }, () => r.contact())),
  );
  const pairs = Array.from({ length: r.number() }, () => ({
    a: r.number(),
    b: r.number(),
    manifolds: Array.from({ length: r.number() }, () => ({
      normal: r.vector(),
      friction: r.number(),
      points: Array.from({ length: r.number() }, () => ({
        distance: r.number(),
        impulse: r.number(),
        p1: r.vector(),
        p2: r.vector(),
      })),
    })),
  }));
  return { ...frame, pairs, actuators, fingers, contacts };
}

// Browser views receive the measured joints, bodies and TCPs used for rendering.
// Actuator diagnostics, contact forces and solver manifolds stay on the host.
export function measuredFrameValues(frame: MeasuredFrame): Float64Array {
  const v: number[] = [frame.tick, frame.bodies.length, 0, 0, ...frame.state, ...frame.target];
  const vector = (p: Vec3) => v.push(p.x, p.y, p.z);
  const rotation = (q: Quat) => v.push(q.x, q.y, q.z, q.w);
  for (const b of frame.bodies) {
    v.push(b.id);
    vector(b.position);
    rotation(b.rotation);
    vector(b.velocity);
    vector(b.angularVelocity);
    vector(b.worldCom);
  }
  for (const p of frame.tcps) {
    vector(p);
    v.push(p.gap);
    rotation(p.rotation);
  }
  return Float64Array.from(v);
}

export function readMeasuredFrame(values: Float64Array): MeasuredFrame {
  const r = new Reader(values),
    { colliders: _, objects: _objects, ...frame } = r.base();
  if (
    !Number.isSafeInteger(frame.tick) ||
    frame.tick < 0 ||
    _objects !== 0 ||
    _.length !== 0 ||
    r.at !== values.length
  )
    throw new Error('Invalid measured frame length');
  return frame;
}
