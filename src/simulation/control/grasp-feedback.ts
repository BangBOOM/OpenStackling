import type { TeacherConfig } from './teacher-policy';
import type { RobotConfig } from '../world/config';
import type { ContactDiagnostic } from '../world/types';

export class GraspFeedback {
  gap: number;
  targetForce = 0;
  private boost = 0;
  constructor(
    private readonly robot: RobotConfig,
    private readonly settings: TeacherConfig['grasp'],
    private readonly mass: number,
    gap: number,
  ) {
    this.gap = gap;
  }
  update(dt: number, contacts: readonly ContactDiagnostic[], respondToSlip: boolean) {
    const bilateral = contacts.every((contact) => contact.normalForce > 0);
    const friction = Math.min(...contacts.map((contact) => contact.friction));
    const slip = Math.max(...contacts.map((contact) => contact.slipSpeed));
    const cap = this.robot.fingerMotor.maxForce * 0.8;
    if (respondToSlip && bilateral && slip > this.settings.slipSpeed) this.boost += cap * dt;
    if (!respondToSlip) this.boost = Math.max(0, this.boost - cap * dt);
    const required =
      friction > 0 ? (this.mass * 9.81 * this.settings.safetyFactor) / (2 * friction) : cap;
    const baseline = Math.min(cap, Math.max(this.settings.minNormalForce, required));
    this.boost = Math.min(this.boost, cap - baseline);
    this.targetForce = baseline + this.boost;
    const force = Math.min(...contacts.map((contact) => contact.normalForce));
    const speed = bilateral
      ? this.settings.forceGain * (force - this.targetForce)
      : -this.robot.speed.gap;
    this.gap = Math.max(
      this.robot.gap[0],
      Math.min(
        this.robot.gap[1],
        this.gap + Math.max(-this.robot.speed.gap, Math.min(this.robot.speed.gap, speed)) * dt,
      ),
    );
    return this.gap;
  }
}
