import { directions } from './manual-keys';
import type { Simulation } from '../world/simulation';
import type { Pose } from '../world/geometry';
import { bodyKin, bodyClear } from './body-planning';
import type { Action16D } from '../world/types';
import { Quaternion } from 'three';
export class Manual {
  name = 'manual';
  private target: Pose;
  constructor(
    private sim: Simulation,
    private keys: Set<string>,
  ) {
    this.target = sim.arms[0].pose();
  }
  reset() {
    this.target = this.sim.arms[0].pose();
  }
  end() {}
  hold() {
    this.target = { ...this.sim.arms[0].pose(), gap: this.target.gap };
  }
  next(dt: number) {
    const r = this.sim.config.environment.robot,
      speed = Math.min(r.keyboardSpeed, this.sim.blockSize * 3);
    const pose = this.sim.arms[0].pose();
    for (const key of this.keys) {
      const [axis, sign] = directions[key];
      const velocity = axis === 'gap' ? r.speed.gap : speed;
      this.target[axis] += sign * velocity * dt;
      if (axis !== 'gap')
        this.target[axis] = Math.max(
          pose[axis] - velocity * 0.3,
          Math.min(pose[axis] + velocity * 0.3, this.target[axis]),
        );
    }
    const half = this.sim.config.environment.tableSize / 2;
    this.target.x = Math.max(-half, Math.min(half, this.target.x));
    const depthHalf = this.sim.config.environment.tableDepth / 2;
    this.target.z = Math.max(-depthHalf, Math.min(depthHalf, this.target.z));
    this.target.y = Math.max(
      this.sim.config.environment.tableTop + 0.006,
      Math.min(1.6, this.target.y),
    );
    this.target.gap = Math.max(r.gap[0], Math.min(r.gap[1], this.target.gap));
    let action;
    {
      const state = this.sim.targetState() as Action16D;
      const kin = bodyKin(this.sim, 0, state.slice(0, 2));
      const q = kin.inverse(
        this.target,
        state.slice(2, 8),
        new Quaternion().copy(this.sim.arms[0].rotation()),
      );
      if (q) {
        const next = [...state] as Action16D;
        next.splice(2, 7, ...q, this.target.gap);
        const candidate = this.sim.bodies
          .map((body, id) => ({
            id,
            distance: Math.hypot(
              body.translation().x - pose.x,
              body.translation().y - pose.y,
              body.translation().z - pose.z,
            ),
          }))
          .sort((a, b) => a.distance - b.distance)[0];
        const grasp = candidate.distance < r.fingerLength ? candidate.id : -1;
        if (bodyClear(this.sim, next, grasp, undefined, 0)) action = next;
      }
    }
    if (!action) this.hold();
    return {
      action: action ?? this.sim.targetState(),
      valid: true,
      reason: '',
      phase: action ? 'manual' : 'out-of-range',
      continuous: true,
    };
  }
}
