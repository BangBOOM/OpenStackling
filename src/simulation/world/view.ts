import { Quaternion, Vector3 } from 'three';
import { halfExtent } from './objects';
import { waistPivot } from './body';
import type { WorldConfig } from './config';
import type { WorldMetadata, MeasuredFrame } from './frame';
import type { Action16D, ArmState, WorldMeasurements } from './types';

export class BodyView {
  constructor(
    readonly view: WorldView,
    readonly id: number,
  ) {}
  private get data() {
    return this.view.frame.bodies[this.id];
  }
  translation() {
    return { ...this.data.position };
  }
  rotation() {
    return { ...this.data.rotation };
  }
  linvel() {
    return { ...this.data.velocity };
  }
  angvel() {
    return { ...this.data.angularVelocity };
  }
  worldCom() {
    return { ...this.data.worldCom };
  }
  mass() {
    return this.view.metadata.bodies[this.id].mass;
  }
  localCom() {
    return { ...this.view.metadata.bodies[this.id].localCom };
  }
  principalInertia() {
    return { ...this.view.metadata.bodies[this.id].principalInertia };
  }
  principalInertiaLocalFrame() {
    const q = this.view.metadata.bodies[this.id].inertiaFrame;
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  }
}

// The browser receives measured frames. It has no physics engine or mutation methods.
export class WorldView<B extends BodyView = BodyView> {
  readonly objects;
  readonly allBodies: B[];
  readonly bodies: B[];
  readonly arms;
  readonly body;
  constructor(
    readonly config: WorldConfig,
    readonly metadata: WorldMetadata,
    public frame: MeasuredFrame,
    makeBody: (view: WorldView<B>, id: number) => B,
  ) {
    this.objects = config.scene;
    this.allBodies = metadata.bodies.map((b) => makeBody(this, b.id));
    this.bodies = metadata.objects.map((id) => this.allBodies[id]);
    this.arms = metadata.arms.map((arm, side) => ({
      base: this.allBodies[metadata.torso],
      bodies: arm.bodies.map((id) => this.allBodies[id]),
      fingers: arm.fingers.map((id) => this.allBodies[id]),
      palm: this.allBodies[arm.bodies[5]],
      state: () => this.state().slice(2 + side * 7, 9 + side * 7) as ArmState,
      targetState: () => this.targetState().slice(2 + side * 7, 9 + side * 7) as ArmState,
      angles: () => this.state().slice(2 + side * 7, 8 + side * 7),
      rotation: () => ({ ...this.frame.tcps[side].rotation }),
      pose: () => {
        const p = this.frame.tcps[side];
        return { x: p.x, y: p.y, z: p.z, gap: p.gap };
      },
    }));
    this.body = {
      torso: this.allBodies[metadata.torso],
      fixed: this.allBodies[metadata.fixed],
      pivot: waistPivot(config.environment.robot),
      angles: () => this.state().slice(0, 2),
      targetState: () => this.targetState().slice(0, 2),
      rotation: () => new Quaternion().copy(this.allBodies[metadata.torso].rotation()).normalize(),
      transform: () => {
        const rotation = new Quaternion()
          .copy(this.allBodies[metadata.torso].rotation())
          .normalize();
        const position = new Vector3()
          .copy(this.allBodies[metadata.torso].translation())
          .sub(waistPivot(config.environment.robot).applyQuaternion(rotation));
        return { position, rotation };
      },
    };
  }
  get ticks() {
    return this.frame.tick;
  }
  get dt() {
    return 1 / this.config.environment.physicsHz;
  }
  get time() {
    return this.ticks * this.dt;
  }
  get blockSize() {
    return halfExtent(this.objects[0].shape, this.objects[0].rotation) * 2;
  }
  get blockCount() {
    return this.objects.length;
  }
  extent(id: number, direction = { x: 0, y: 1, z: 0 }) {
    return halfExtent(this.objects[id].shape, this.bodies[id].rotation(), direction);
  }
  top(id: number) {
    return this.bodies[id].translation().y + this.extent(id);
  }
  bottom(id: number) {
    return this.bodies[id].translation().y - this.extent(id);
  }
  state() {
    return [...this.frame.state] as Action16D;
  }
  targetState() {
    return [...this.frame.target] as Action16D;
  }
  inspect(): WorldMeasurements {
    return {
      tick: this.ticks,
      time: this.time,
      state: this.state(),
      target: this.targetState(),
      tcps: this.frame.tcps,
      blocks: this.bodies.map((b) => ({
        position: b.translation(),
        rotation: b.rotation(),
        velocity: b.linvel(),
        angularVelocity: b.angvel(),
      })),
    };
  }
}
