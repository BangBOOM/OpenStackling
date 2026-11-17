import {
  choosePlan,
  graspKey,
  transport,
  vector,
  type Plan,
  type GraspSearch,
} from './grasp-search';
import type { TeacherContext } from './types';
import type { TeacherDecision, PlacementCandidate, WholeBodyPlanner } from './whole-body-types';
import { bodyPlanner } from './body-planner';
import { Quaternion, Vector3 } from 'three';
import type { Simulation } from '../../world/simulation';
import type { Action16D } from '../../world/types';
import { halfExtent } from '../../world/objects';

import {
  bodyKin,
  bodyClear,
  cartesianPathSteps,
  jointPathSteps,
  samplePath,
  timePath,
  pathClearSteps,
  type Path,
  type Payload,
} from '../body-planning';
import { contact, inspectStructures } from '../../tasks/structures';
import { placementPositioned, placementSettled } from '../placement-verification';
import { finishPlanning, type PlanningWork } from '../planning-work';
import { GraspFeedback } from '../grasp-feedback';

type Phase =
  | 'settle'
  | 'approach'
  | 'descend'
  | 'close'
  | 'carry'
  | 'place'
  | 'open'
  | 'retreat'
  | 'verify'
  | 'success'
  | 'failed';
export class WholeBodyTeacher {
  phase: Phase = 'settle';
  reason = '';
  completedPlacements = 0;
  readonly rejected = { ik: 0, ready: 0, approach: 0, insert: 0 };
  readonly decisions: TeacherDecision[] = [];
  private previousWaistDelta = [0, 0];
  private plan?: Plan;
  private path?: Path;
  private paths: Path[] = [];
  private started = 0;
  private pathTime = 0;
  private nominalRate = 1;
  private pathRate = 1;
  private desiredRate = 1;
  private grasp?: GraspFeedback;
  private placementCorrections = 0;
  private landingGap?: number;
  private stable = 0;
  private releasedStable = 0;
  private lost = 0;
  private hold: Action16D;
  private payload?: Payload;
  private releaseRotation = new Quaternion();
  private retreat?: Path;
  private carried?: Path;
  private size = 0;
  private get settings() {
    return this.context.teacher;
  }
  private recovering = false;
  private placementCommitted = false;
  private rejectedGrasps = new Set<string>();
  private retries = new Map<number, number>();
  constructor(
    private sim: Simulation,
    private context: TeacherContext,
    private planner: WholeBodyPlanner = bodyPlanner(sim, context),
  ) {
    this.hold = sim.targetState() as Action16D;
  }
  private fail(reason: string) {
    this.reason = reason;
    this.phase = 'failed';
  }
  private enter(phase: Phase, path?: Path) {
    this.phase = phase;
    this.started = this.sim.time;
    this.stable = 0;
    this.path = path;
    this.pathTime = 0;
    this.pathRate = this.desiredRate = this.nominalRate;
  }
  private arm() {
    return this.sim.arms[this.plan!.arm];
  }
  private supported() {
    const p = this.plan!;
    return contact(
      this.sim,
      this.sim.bodies[p.object].collider(0),
      p.goal.support === null ? this.sim.table : this.sim.bodies[p.goal.support].collider(0),
      true,
    );
  }
  private measuredPayload(state = this.sim.targetState() as Action16D): Payload {
    const body = this.sim.bodies[this.plan!.object],
      tool = bodyKin(this.sim, this.plan!.arm, state.slice(0, 2)).forward(
        state.slice(2 + this.plan!.arm * 7, 8 + this.plan!.arm * 7),
      ),
      inverse = tool.rotation.clone().invert();
    // Calibrate the planning attachment to the measured object at this joint pose.
    return {
      side: this.plan!.arm,
      position: vector(body.translation()).sub(tool.position).applyQuaternion(inverse),
      rotation: inverse.multiply(new Quaternion().copy(body.rotation())),
    };
  }
  private recover(reason: string) {
    const p = this.plan!,
      sim = this.sim,
      attempts = this.retries.get(p.object) ?? 0;
    if (attempts >= 2 || !contact(sim, sim.bodies[p.object].collider(0), sim.table, true)) {
      this.fail(reason);
      return;
    }
    this.retries.set(p.object, attempts + 1);
    this.rejectedGrasps.add(graspKey(p.object, p.arm, p.grasp));
    this.recovering = true;
    this.hold = sim.targetState() as Action16D;
    this.hold[8 + p.arm * 7] = Math.min(sim.config.environment.robot.gap[1], this.size + 0.035);
    this.retreat = timePath(
      sim,
      [...p.insert.samples].reverse().map((q) => {
        const open = [...q] as Action16D;
        open[8 + p.arm * 7] = this.hold[8 + p.arm * 7];
        return open;
      }),
    );
    this.carried = p.approach ?? p.ready;
    this.enter('open');
  }
  private *choose(goals: PlacementCandidate[], search: GraspSearch): PlanningWork<Plan | null> {
    const select = (allowTransfer: boolean) =>
      choosePlan(
        this.sim,
        this.settings,
        this.previousWaistDelta,
        this.rejectedGrasps,
        this.rejected,
        goals,
        search,
        allowTransfer,
      );
    return (yield* select(false)) ?? (yield* select(true));
  }
  private commitPlacement() {
    if (!this.placementCommitted && this.releasedStable > 0.5) {
      this.planner.placed(this.plan!.goal);
      this.completedPlacements++;
      this.placementCommitted = true;
    }
    return this.placementCommitted;
  }
  private *nextBlock(): PlanningWork {
    if (this.planner.done) {
      this.enter('success');
      return;
    }
    let goals = this.planner.candidates(),
      plan: Plan | null = null;
    // Candidate paths share a cache only while physics is frozen in this search.
    const search: GraspSearch = { solutions: new Map(), pickups: new Map() };
    while (goals.length) {
      plan = yield* this.choose(goals, search);
      if (plan) break;
      for (const goal of goals) this.planner.rejected(goal);
      goals = this.planner.candidates();
    }
    if (!plan) {
      if (this.planner.allowPartial) this.enter('success');
      else this.fail(this.planner.failure ?? 'No collision-free whole-body grasp');
      return;
    }
    this.startPlan(plan);
  }
  private startPlan(plan: Plan) {
    this.placementCommitted = false;
    this.landingGap = undefined;
    this.releasedStable = 0;
    const current = this.sim.targetState();
    this.previousWaistDelta = plan.waist.map((v, i) => {
      const delta = v - current[i];
      // Arm-only work must not erase the direction of the preceding waist movement.
      return Math.abs(delta) > 1e-6 ? delta : this.previousWaistDelta[i];
    });
    this.plan = plan;
    this.size = plan.width;
    this.decisions.push({
      arm: plan.arm,
      object: plan.object,
      grasp: plan.grasp.kind,
      waist: plan.waist,
      cost: plan.cost,
    });
    this.paths = plan.pickup.slice(1);
    this.enter('approach', plan.pickup[0]);
  }
  private arrived() {
    if (!this.path || this.pathTime < this.path.duration) return false;
    const expected = this.path.samples.at(-1)!;
    const target = this.sim.targetState();
    if (
      target.some(
        (value, joint) => joint !== 8 && joint !== 15 && Math.abs(value - expected[joint]) > 1e-9,
      )
    )
      return false;
    const state = this.sim.state();
    return state.every((v, i) => (i === 8 || i === 15 ? true : Math.abs(v - expected[i]) < 0.025));
  }
  private *carry(): PlanningWork {
    const sim = this.sim,
      p = this.plan!,
      arm = this.arm();
    this.hold = sim.targetState() as Action16D;
    this.payload = this.measuredPayload(this.hold);
    this.placementCorrections = 0;
    this.releaseRotation.copy(p.goal.rotation).multiply(this.payload.rotation.clone().invert());
    p.destination.y =
      (p.goal.support !== null ? sim.top(p.goal.support) : sim.config.environment.tableTop) +
      halfExtent(sim.objects[p.object].shape, p.goal.rotation) -
      0.0008;
    const paths = yield* transport(
      this.sim,
      this.settings,
      this.hold,
      p.arm,
      p.grasp,
      p.destination,
      this.payload,
      arm.pose().gap,
      p.object,
      new Quaternion().copy(p.goal.rotation),
      true,
    );
    if (!paths) {
      this.recover('No safe transport after contact');
      return;
    }
    const { carry, place } = paths;
    this.carried = carry;
    this.retreat = timePath(
      sim,
      [...place.samples].reverse().map((q) => {
        const state = [...q] as Action16D;
        state[8 + p.arm * 7] = Math.min(sim.config.environment.robot.gap[1], this.size + 0.025);
        return state;
      }),
    );
    this.paths = [place];
    this.enter('carry', carry);
  }
  update() {
    finishPlanning(this.updateSteps());
  }
  *updateSteps(): PlanningWork {
    if (this.phase === 'failed' || this.phase === 'success') return;
    const sim = this.sim,
      elapsed = sim.time - this.started;
    this.pathRate += Math.max(-sim.dt, Math.min(sim.dt, this.desiredRate - this.pathRate));
    this.pathTime += sim.dt * this.pathRate;
    if (elapsed > (this.path ? this.path.duration / this.nominalRate : 2) + 12) {
      this.fail(`${this.phase} timed out`);
      return;
    }
    if (this.plan && (this.phase === 'carry' || (this.phase === 'place' && !this.supported()))) {
      this.lost = this.arm().contact(sim.bodies[this.plan.object]).every(Boolean)
        ? 0
        : this.lost + sim.dt;
      if (this.lost > 0.3) {
        this.fail('Lost grasp');
        return;
      }
    }
    // Confirm the same released placement while withdrawing, instead of restarting
    // its stability window after the arm has already finished retreating.
    this.releasedStable =
      this.plan &&
      !this.recovering &&
      ['retreat', 'verify'].includes(this.phase) &&
      placementSettled(sim, this.plan.goal, sim.touching(sim.bodies[this.plan.object]))
        ? this.releasedStable + sim.dt
        : 0;
    switch (this.phase) {
      case 'settle':
        this.stable = inspectStructures(sim).every((structure) => structure.stable)
          ? this.stable + sim.dt
          : 0;
        if (this.stable + 1e-9 >= this.settings.settleSeconds) yield* this.nextBlock();
        break;
      case 'approach':
        if (vector(this.arm().pose()).distanceTo(this.plan!.grip) < 0.07) this.phase = 'descend';
      // The approach and insertion share one clock; grasp confirmation starts at its end.
      case 'descend':
        if (this.arrived()) {
          if (this.paths.length) {
            this.enter('approach', this.paths.shift());
            break;
          }
          this.hold = sim.targetState() as Action16D;
          this.grasp = new GraspFeedback(
            sim.config.environment.robot,
            this.settings.grasp,
            sim.bodies[this.plan!.object].mass(),
            this.hold[8 + this.plan!.arm * 7],
          );
          this.enter('close');
        }
        break;
      case 'close':
        this.stable = this.arm()
          .contactFeedback(sim.bodies[this.plan!.object])
          .every(
            (contact) =>
              contact.normalForce >= this.settings.grasp.minNormalForce * 0.6 &&
              contact.slipSpeed < this.settings.grasp.slipSpeed,
          )
          ? this.stable + sim.dt
          : 0;
        if (this.stable >= this.settings.contactSeconds) yield* this.carry();
        else if (elapsed > 2.5) this.recover('Could not establish a bilateral grasp');
        break;
      case 'carry':
        if (this.arrived()) this.enter('place', this.paths.shift());
        break;
      case 'place':
        if (this.arrived()) {
          const body = sim.bodies[this.plan!.object],
            v = body.linvel();
          const w = body.angvel();
          this.stable =
            this.supported() &&
            Math.hypot(v.x, v.y, v.z) < 0.025 &&
            Math.hypot(w.x, w.y, w.z) < 0.05
              ? this.stable + sim.dt
              : 0;
          if (
            this.stable === 0 &&
            this.landingGap === undefined &&
            this.pathTime > this.path!.duration + 0.25 &&
            this.placementCorrections < 3 &&
            Math.hypot(v.x, v.y, v.z) < 0.025
          ) {
            const p = this.plan!,
              delta = p.destination.clone().sub(body.translation());
            if (delta.length() < 0.015 && delta.y < -0.0005) {
              this.placementCorrections++;
              const payload = this.measuredPayload();
              const rotation = new Quaternion()
                .copy(p.goal.rotation)
                .multiply(payload.rotation.clone().invert());
              const target = p.destination
                .clone()
                .sub(payload.position.clone().applyQuaternion(rotation));
              const from = sim.targetState() as Action16D;
              const correction = yield* cartesianPathSteps(
                sim,
                from,
                p.arm,
                [target],
                rotation,
                from[8 + p.arm * 7],
                p.object,
                payload,
              );
              if (correction) {
                this.path = correction;
                this.pathTime = 0;
                this.pathRate = this.desiredRate = this.nominalRate;
              }
            }
          }
          if (this.stable > 0.25) {
            this.hold = sim.targetState() as Action16D;
            this.hold[8 + this.plan!.arm * 7] = Math.min(
              sim.config.environment.robot.gap[1],
              this.size + 0.025,
            );
            this.enter('open');
          }
        }
        break;
      case 'open':
        if (this.arm().pose().gap > this.hold[8 + this.plan!.arm * 7] - 0.003) {
          const p = this.plan!,
            ready = [...p.rest] as Action16D;
          const retreatRotation = this.recovering ? p.grasp.rotation : this.releaseRotation;
          ready[8 + p.arm * 7] = this.hold[8 + p.arm * 7];
          if (!this.recovering) {
            const tip = bodyKin(sim, p.arm, this.hold.slice(0, 2)).forward(
              this.hold.slice(2 + p.arm * 7, 8 + p.arm * 7),
            ).position;
            // Withdraw along the tool axis before folding or changing wrist orientation.
            const exit = new Vector3(-1, 0, 0)
              .applyQuaternion(retreatRotation)
              .multiplyScalar(sim.config.environment.robot.fingerLength + 0.04)
              .add(tip);
            const clearance = yield* cartesianPathSteps(
              sim,
              this.hold,
              p.arm,
              [exit],
              retreatRotation,
              this.hold[8 + p.arm * 7],
              -1,
            );
            if (clearance) {
              this.retreat = clearance;
              this.paths = [];
              const from = clearance.samples.at(-1)!;
              for (const blend of [0.65, 1]) {
                const relaxed = [...from] as Action16D;
                for (let i = 0; i < 6; i++)
                  relaxed[2 + p.arm * 7 + i] +=
                    blend *
                    (sim.config.environment.robot.homeJoints[i] - relaxed[2 + p.arm * 7 + i]);
                const park = yield* jointPathSteps(sim, from, relaxed, -1);
                if (park) {
                  this.paths = [park];
                  break;
                }
              }
              this.enter('retreat', clearance);
              return;
            }
          }
          if (!(yield* pathClearSteps(sim, this.retreat!, -1))) {
            if (!this.recovering) {
              this.paths = [];
              this.enter('verify');
            } else this.fail('No collision-free retreat');
            return;
          }
          const samples = this.retreat!.samples.map((q) => [...q] as Action16D);
          let park = yield* jointPathSteps(sim, samples.at(-1)!, ready, -1);
          if (!park) {
            const from = samples.at(-1)!,
              kin = bodyKin(sim, p.arm, from.slice(0, 2));
            const point = kin.forward(from.slice(2 + p.arm * 7, 8 + p.arm * 7)).position;
            for (const rise of [0, 0.08, 0.14]) {
              const up = point.clone().add(new Vector3(0, rise, 0));
              const outside = up.clone();
              outside.x = (p.arm === 0 ? -1 : 1) * 0.3;
              const escape = yield* cartesianPathSteps(
                sim,
                from,
                p.arm,
                [up, outside],
                retreatRotation,
                this.hold[8 + p.arm * 7],
                -1,
              );
              if (!escape) continue;
              const home = yield* jointPathSteps(sim, escape.samples.at(-1)!, ready, -1);
              if (home) {
                this.paths = [escape, home];
                this.enter('retreat', this.retreat);
                return;
              }
            }
          }
          if (!park)
            for (const q of [...this.carried!.samples].reverse()) {
              const open = [...q] as Action16D;
              open[8 + p.arm * 7] = this.hold[8 + p.arm * 7];
              if (!bodyClear(sim, open, -1)) break;
              samples.push(open);
              park = yield* jointPathSteps(sim, open, ready, -1);
              if (park) break;
            }
          const withdrawal = park ? timePath(sim, samples) : this.retreat!;
          const safe = yield* pathClearSteps(sim, withdrawal, -1);
          this.paths = park && safe ? [park] : [];
          this.enter('retreat', safe ? withdrawal : this.retreat);
        }
        break;
      case 'retreat':
        if (this.arrived()) {
          if (!this.recovering && this.paths.length && this.commitPlacement()) {
            if (this.planner.done) {
              this.enter('success');
              break;
            }
            const plan = yield* this.choose(this.planner.candidates(), {
              solutions: new Map(),
              pickups: new Map(),
            });
            if (plan) {
              this.startPlan(plan);
              break;
            }
          }
          this.paths.length ? this.enter('retreat', this.paths.shift()) : this.enter('verify');
        }
        break;
      case 'verify':
        {
          const body = sim.bodies[this.plan!.object],
            v = body.linvel();
          if (this.recovering) {
            this.stable =
              contact(sim, body.collider(0), sim.table, true) &&
              !sim.touching(body) &&
              Math.hypot(v.x, v.y, v.z) < 0.025
                ? this.stable + sim.dt
                : 0;
            if (this.stable > 0.35) {
              this.recovering = false;
              yield* this.nextBlock();
            }
            break;
          }
          if (this.commitPlacement()) yield* this.nextBlock();
        }
        break;
    }
  }
  next(dt: number) {
    const action = this.path ? samplePath(this.path, this.pathTime) : ([...this.hold] as Action16D);
    // Preserve reference command density when a lower control rate is selected.
    this.nominalRate = Math.min(1, 0.05 / dt);
    this.desiredRate = this.nominalRate;
    if (this.path) {
      const diagnostics = [
        ...this.sim.body.diagnostics(),
        ...this.sim.arms.flatMap((arm) => arm.diagnostics()),
      ];
      const error = Math.max(...diagnostics.map((joint) => Math.abs(joint.trackingError)));
      const saturated = diagnostics.some(
        (joint) => Math.abs(joint.requestedTorqueEstimate) >= joint.torqueLimit,
      );
      if (error > 0.025 && saturated)
        this.desiredRate = this.nominalRate * Math.max(0, 1 - (error - 0.025) / 0.05);
    }
    if (this.plan && this.grasp && ['close', 'carry', 'place'].includes(this.phase)) {
      const contacts = this.arm().contactFeedback(this.sim.bodies[this.plan.object]);
      action[8 + this.plan.arm * 7] = this.grasp.update(dt, contacts, this.phase === 'carry');
      if (this.phase === 'place' && this.placementCorrections >= 3 && this.arrived()) {
        const p = this.plan,
          supportTop =
            p.goal.support === null
              ? this.sim.config.environment.tableTop
              : this.sim.top(p.goal.support),
          separation = this.sim.bottom(p.object) - supportTop;
        if (
          this.landingGap !== undefined ||
          (separation >= 0 && separation <= 0.002 && placementPositioned(this.sim, p.goal))
        ) {
          const robot = this.sim.config.environment.robot,
            width =
              2 *
              halfExtent(
                this.sim.objects[p.object].shape,
                this.sim.bodies[p.object].rotation(),
                new Vector3(0, 0, 1).applyQuaternion(this.arm().rotation()),
              );
          // Unload within 2 mm of the intended support; full opening still waits for measured support.
          this.landingGap = Math.min(
            robot.gap[1],
            width + 0.002,
            (this.landingGap ?? this.arm().pose().gap) + robot.speed.gap * dt,
          );
          action[8 + p.arm * 7] = this.landingGap;
        }
      }
      if (
        this.phase === 'carry' &&
        contacts.some((contact) => contact.slipSpeed > this.settings.grasp.slipSpeed)
      )
        this.desiredRate = Math.min(this.desiredRate, this.nominalRate * 0.25);
    }
    if (this.path) this.hold = action;
    return {
      action,
      valid: this.phase !== 'failed',
      reason: this.reason,
      phase: this.phase,
      continuous: Boolean(this.path && this.pathTime < this.path.duration),
    };
  }
}
