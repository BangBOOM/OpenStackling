import { Vector3 } from 'three';
import { physicsBinding } from './binding';
import { readPhysicsFrame } from './frame-buffer';
import { validateWorldConfig, type WorldConfig } from './config';
import { armConfig, waistPivot } from './body';
import { forward, linkCollider, tableFrame } from './geometry';
import { mountShapes } from './mount';
import { BodyView, WorldView } from './view';
import { Shape } from './shape';
import type { WorldMetadata, PhysicsFrame } from './frame';
import type { Action, Vec3, Quat, WorldSnapshot } from './types';

import { actionLimits } from './actions';

function layout(config: WorldConfig) {
  const r = config.environment.robot;
  const primitive = (
    kind: string,
    size: number[],
    position: Vec3,
    rotation: Quat = { x: 0, y: 0, z: 0, w: 1 },
  ) => ({
    shape:
      kind === 'box'
        ? { kind: 'cuboid', size }
        : kind === 'cylinder'
          ? { kind, height: size[1], radius: size[0] }
          : { kind: 'sphere', radius: size[0] },
    position,
    rotation,
  });
  return {
    pivot: waistPivot(r),
    mount: mountShapes(r).map((s) => primitive(s.kind, s.size, s.position, s.rotation)),
    table: tableFrame(config.environment).map((s) =>
      primitive('box', s.size, new Vector3(...s.position)),
    ),
    links: Array.from({ length: 6 }, (_, i) => {
      const s = linkCollider(r, i);
      return primitive(s.kind, s.size, { x: s.x, y: 0, z: 0 });
    }),
    arms: [0, 1].map((side) => {
      const arm = armConfig(r, side);
      return {
        base: new Vector3(...(arm.base as [number, number, number])),
        frames: forward(arm, r.homeJoints).frames,
      };
    }),
  };
}
export class PhysicsCollider {
  readonly shape: Shape;
  constructor(
    private sim: Simulation,
    readonly id: number,
  ) {
    this.shape = new Shape(sim.metadata.colliders[id].shape);
  }
  translation() {
    return { ...this.sim.frame.colliders[this.id].position };
  }
  rotation() {
    return { ...this.sim.frame.colliders[this.id].rotation };
  }
  intersectsShape(shape: Shape, position: Vec3, rotation: Quat) {
    return (
      this.shape.contactShape(this.translation(), this.rotation(), shape, position, rotation, 0) !==
      null
    );
  }
  containsPoint(point: Vec3) {
    return physicsBinding.shapeContains(
      JSON.stringify({
        shape: this.shape.definition,
        position: this.translation(),
        rotation: this.rotation(),
        point,
      }),
    );
  }
  setFriction(friction: number) {
    this.sim.setCollider(this.id, { friction });
  }
}
export class PhysicsBody extends BodyView {
  private get sim() {
    return this.view as Simulation;
  }
  collider(index: number) {
    return this.sim.colliders[this.view.metadata.bodies[this.id].colliders[index]];
  }
  setTranslation(position: Vec3) {
    this.sim.setBody(this.id, { position });
  }
  setRotation(rotation: Quat) {
    this.sim.setBody(this.id, { rotation });
  }
  setLinvel(velocity: Vec3) {
    this.sim.setBody(this.id, { velocity });
  }
  setAngvel(angularVelocity: Vec3) {
    this.sim.setBody(this.id, { angularVelocity });
  }
  setGravityScale(gravityScale: number) {
    this.sim.setBody(this.id, { gravityScale });
  }
  setAdditionalMass(additionalMass: number) {
    this.sim.setBody(this.id, { additionalMass });
  }
  isDynamic() {
    return this.view.metadata.bodies[this.id].dynamic;
  }
  applyImpulseAtPoint(impulse: Vec3, point: Vec3) {
    this.sim.setBody(this.id, { impulse, point });
  }
  applyImpulse(impulse: Vec3) {
    this.sim.setBody(this.id, { impulse });
  }
  applyTorqueImpulse(torqueImpulse: Vec3) {
    this.sim.setBody(this.id, { torqueImpulse });
  }
  addForce(force: Vec3) {
    this.sim.setBody(this.id, { force });
  }
  addTorque(torque: Vec3) {
    this.sim.setBody(this.id, { torque });
  }
  resetForces() {
    this.sim.setBody(this.id, { resetForces: true });
  }
  resetTorques() {
    this.sim.setBody(this.id, { resetTorques: true });
  }
  velocityAtPoint(point: Vec3) {
    return new Vector3()
      .copy(this.angvel())
      .cross(new Vector3().copy(point).sub(this.worldCom()))
      .add(this.linvel());
  }
}
function initialFrame(physics: InstanceType<typeof physicsBinding.NativeWorld>) {
  let buffer = new Float64Array(2048);
  const length = physics.frame(buffer);
  if (length > buffer.length) {
    buffer = new Float64Array(length * 2);
    physics.frame(buffer);
  }
  return buffer.subarray(0, length);
}
export class Simulation extends WorldView<PhysicsBody> {
  declare frame: PhysicsFrame;
  declare readonly body: WorldView<PhysicsBody>['body'] & {
    diagnostics(): PhysicsFrame['actuators'];
  };
  declare readonly arms: (WorldView<PhysicsBody>['arms'][number] & {
    diagnostics(): PhysicsFrame['actuators'];
    fingerDiagnostics(): PhysicsFrame['fingers'][number];
    contactFeedback(object: BodyView): PhysicsFrame['contacts'][number][number];
    contact(object: BodyView): boolean[];
    touching(object: BodyView): boolean;
  })[];
  private buffer = new Float64Array(2048);
  private physics: InstanceType<typeof physicsBinding.NativeWorld>;
  readonly colliders: PhysicsCollider[];
  readonly table: PhysicsCollider;
  constructor(config: WorldConfig) {
    validateWorldConfig(config);
    const physics = new physicsBinding.NativeWorld(
      JSON.stringify({ ...config, layout: layout(config) }),
    );
    const metadata = JSON.parse(physics.metadata()) as WorldMetadata;
    super(
      structuredClone(config),
      metadata,
      readPhysicsFrame(initialFrame(physics)),
      (view, id) => new PhysicsBody(view, id),
    );
    this.physics = physics;
    this.colliders = metadata.colliders.map((c) => new PhysicsCollider(this, c.id));
    this.table = this.colliders[metadata.table];
    Object.assign(this.body, { diagnostics: () => this.frame.actuators.slice(0, 2) });
    this.arms.forEach((arm, side) => {
      const bodyIds = metadata.arms[side];
      Object.assign(arm, {
        diagnostics: () => this.frame.actuators.slice(2 + side * 6, 8 + side * 6),
        fingerDiagnostics: () => this.frame.fingers[side],
        contactFeedback: (object: BodyView) =>
          this.frame.contacts[side][metadata.objects.indexOf(object.id)],
        contact: (object: BodyView) =>
          bodyIds.fingers.map((id) => this.hasContact(id, object.id, true)),
        touching: (object: BodyView) =>
          [metadata.torso, ...bodyIds.bodies, ...bodyIds.fingers].some((id) =>
            this.hasContact(id, object.id),
          ),
      });
    });
  }
  private hasContact(a: number, b: number, positive = false) {
    const ac = this.metadata.bodies[a].colliders,
      bc = this.metadata.bodies[b].colliders;
    return this.frame.pairs.some(
      (pair) =>
        ((ac.includes(pair.a) && bc.includes(pair.b)) ||
          (ac.includes(pair.b) && bc.includes(pair.a))) &&
        pair.manifolds.some((m) =>
          m.points.some((p) => p.impulse > 0 || (!positive && p.distance <= 0.0002)),
        ),
    );
  }
  touching(object: BodyView) {
    return this.arms.some((arm) => arm.touching(object));
  }
  inspect(): WorldSnapshot {
    return {
      ...super.inspect(),
      actuators: this.frame.actuators,
      fingers: this.frame.fingers,
      contacts: this.frame.contacts,
    };
  }
  apply(action: Action, continuous = false) {
    const limits = actionLimits(this.config.environment.robot);
    if (
      !Array.isArray(action) ||
      action.length !== 16 ||
      action.some((v, i) => !Number.isFinite(v) || v < limits[i][0] || v > limits[i][1])
    )
      throw new Error('Action must contain sixteen finite, in-range absolute targets');
    this.physics.apply(action, continuous);
    this.frame.target = [...action];
  }
  step() {
    this.readFrame(this.physics.step(this.buffer));
  }
  private readFrame(length: number) {
    if (length > this.buffer.length) {
      this.buffer = new Float64Array(length * 2);
      this.physics.frame(this.buffer);
    }
    this.frame = readPhysicsFrame(this.buffer.subarray(0, length));
  }
  setBody(id: number, command: Record<string, unknown>) {
    this.physics.setBody(JSON.stringify({ id, ...command }));
    this.readFrame(this.physics.frame(this.buffer));
    Object.assign(this.metadata, JSON.parse(this.physics.metadata()));
  }
  setCollider(id: number, command: Record<string, unknown>) {
    this.physics.setCollider(JSON.stringify({ id, ...command }));
  }
  reset() {
    this.dispose();
    this.physics = new physicsBinding.NativeWorld(
      JSON.stringify({ ...this.config, layout: layout(this.config) }),
    );
    Object.assign(this.metadata, JSON.parse(this.physics.metadata()));
    this.readFrame(this.physics.frame(this.buffer));
  }
  dispose() {
    this.physics.dispose();
  }
}
