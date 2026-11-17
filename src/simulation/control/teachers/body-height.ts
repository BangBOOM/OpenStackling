import { Quaternion, Vector3 } from 'three';
import { inspectStructures } from '../../tasks/structures';
import { halfExtent, IDENTITY, isCube, type ShapeSpec } from '../../world/objects';
import type { Simulation } from '../../world/simulation';
import type { Quat } from '../../world/types';
import type { TeacherContext } from './types';
import type { PlacementCandidate, WholeBodyPlanner } from './whole-body-types';

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const ORIENTATIONS: Quat[] = [
  IDENTITY,
  { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
  { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 },
];
type Footprint = { u: Vector3; v: Vector3; x: number; z: number; radius?: number };
type Choice = {
  goal: PlacementCandidate;
  height: number;
  projectedHeight: number;
  duration: number;
  footprint: Footprint;
};

export class BodyHeightPlanner implements WholeBodyPlanner {
  readonly allowPartial = true;
  private attempted = new Set<string>();
  private used = new Set<number>();
  private exhausted = false;

  constructor(
    private sim: Simulation,
    private context: TeacherContext,
  ) {}

  get done() {
    return this.exhausted;
  }

  candidates(): PlacementCandidate[] {
    const sim = this.sim;
    const structures = inspectStructures(sim).filter((s) => s.stable && s.tower);
    const sources = structures
      .filter((s) => s.ids.length === 1)
      .map((s) => s.ids[0])
      .filter((id) => !this.used.has(id) && this.graspable(id));
    const initialHeight = Math.max(0, ...structures.map((s) => s.height));
    const remaining = this.context.maxSeconds - sim.time;
    const choices: Choice[] = [];

    for (const structure of structures) {
      const support = structure.tower!.at(-1)!;
      const footprint = this.supportFootprint(support);
      if (!footprint) continue;
      const anchor = sim.bodies[support].translation();
      for (const object of sources) {
        if (object === support) continue;
        for (const [orientation, rotation] of this.rotations(object, footprint).entries()) {
          const top = this.placementFootprint(object, rotation, footprint);
          if (!this.fits(top, footprint)) continue;
          const height =
            sim.top(support) +
            halfExtent(sim.objects[object].shape, rotation) * 2 -
            sim.config.environment.tableTop;
          const duration = this.duration(object, anchor.x, anchor.z, height, rotation);
          const key = `${object}:${support}:${orientation}`;
          if (
            this.attempted.has(key) ||
            height > this.context.maxStackHeight ||
            duration + 8 > remaining
          )
            continue;
          choices.push({
            goal: {
              key,
              value: 0,
              object,
              support,
              position: {
                x: anchor.x,
                y: sim.top(support) + halfExtent(sim.objects[object].shape, rotation),
                z: anchor.z,
              },
              rotation,
            },
            height,
            projectedHeight: height,
            duration,
            footprint: top,
          });
        }
      }
    }

    // Two bounded continuations reward a useful platform over an early narrow tip.
    for (const choice of choices) {
      let beam = [
        {
          height: choice.height,
          duration: choice.duration,
          footprint: choice.footprint,
          used: new Set([choice.goal.object, choice.goal.support!]),
        },
      ];
      for (let depth = 0; depth < 2; depth++) {
        const next: typeof beam = [];
        for (const state of beam) {
          for (const object of sources) {
            if (state.used.has(object)) continue;
            for (const rotation of this.rotations(object, state.footprint)) {
              const footprint = this.placementFootprint(object, rotation, state.footprint);
              if (!this.fits(footprint, state.footprint)) continue;
              const height = state.height + halfExtent(sim.objects[object].shape, rotation) * 2;
              const duration =
                state.duration +
                this.duration(
                  object,
                  choice.goal.position.x,
                  choice.goal.position.z,
                  height,
                  rotation,
                );
              if (height > this.context.maxStackHeight || duration + 8 > remaining) continue;
              choice.projectedHeight = Math.max(choice.projectedHeight, height);
              next.push({ height, duration, footprint, used: new Set([...state.used, object]) });
            }
          }
        }
        next.sort(
          (a, b) =>
            b.height - a.height ||
            b.footprint.x * b.footprint.z - a.footprint.x * a.footprint.z ||
            a.duration - b.duration,
        );
        beam = next.slice(0, 8);
        if (!beam.length) break;
      }
      choice.goal.value = choice.projectedHeight / this.context.maxStackHeight;
    }
    const candidates = choices
      .filter((choice) => choice.projectedHeight > initialHeight + 0.003)
      .sort(
        (a, b) =>
          b.projectedHeight - a.projectedHeight ||
          b.height - a.height ||
          b.footprint.x * b.footprint.z - a.footprint.x * a.footprint.z ||
          a.duration - b.duration ||
          a.goal.key.localeCompare(b.goal.key),
      )
      .slice(0, 12)
      .map((choice) => choice.goal);
    this.exhausted = candidates.length === 0;
    return candidates;
  }

  placed(goal: PlacementCandidate) {
    this.used.add(goal.object);
    if (goal.support !== null) this.used.add(goal.support);
    this.attempted.add(goal.key);
    this.exhausted = false;
  }

  rejected(goal: PlacementCandidate) {
    this.attempted.add(goal.key);
  }

  private graspable(id: number) {
    const sim = this.sim;
    return (
      sim.objects[id].shape.kind !== 'sphere' &&
      Math.min(sim.extent(id, AXES[0]), sim.extent(id, AXES[2])) * 2 <=
        sim.config.environment.robot.gap[1] - 0.004
    );
  }

  private supportFootprint(id: number): Footprint | null {
    const sim = this.sim,
      shape = sim.objects[id].shape;
    if (shape.kind === 'sphere') return null;
    const q = new Quaternion().copy(sim.bodies[id].rotation());
    const axes = AXES.map((axis) => axis.clone().applyQuaternion(q));
    const vertical = axes.findIndex((axis) => Math.abs(axis.y) > Math.cos(0.03));
    if (vertical < 0 || (shape.kind === 'cylinder' && vertical !== 1)) return null;
    const u = axes[vertical === 0 ? 2 : 0].clone();
    u.y = 0;
    u.normalize();
    const v = new Vector3(-u.z, 0, u.x);
    return this.footprint(shape, q, u, v);
  }

  private rotations(id: number, footprint: Footprint): Quat[] {
    const shape = this.sim.objects[id].shape;
    const yaw = new Quaternion().setFromAxisAngle(
      AXES[1],
      Math.atan2(-footprint.u.z, footprint.u.x),
    );
    return (shape.kind === 'cuboid' && !isCube(shape) ? ORIENTATIONS : [IDENTITY]).map(
      (rotation) => {
        const q = yaw.clone().multiply(new Quaternion().copy(rotation));
        return { x: q.x, y: q.y, z: q.z, w: q.w };
      },
    );
  }

  private footprint(shape: ShapeSpec, rotation: Quat, u: Vector3, v: Vector3): Footprint {
    return {
      u,
      v,
      x: halfExtent(shape, rotation, u),
      z: halfExtent(shape, rotation, v),
      ...(shape.kind === 'cylinder' ? { radius: shape.radius } : {}),
    };
  }

  private placementFootprint(id: number, rotation: Quat, support: Footprint) {
    return this.footprint(this.sim.objects[id].shape, rotation, support.u, support.v);
  }

  private fits(top: Footprint, support: Footprint) {
    if (support.radius !== undefined)
      return (top.radius ?? Math.hypot(top.x, top.z)) <= support.radius + 0.001;
    return top.x <= support.x + 0.001 && top.z <= support.z + 0.001;
  }

  private duration(id: number, x: number, z: number, height: number, rotation: Quat) {
    const sim = this.sim,
      source = sim.bodies[id].translation();
    const turning = new Quaternion()
      .copy(sim.bodies[id].rotation())
      .angleTo(new Quaternion().copy(rotation));
    return (
      18 +
      Math.hypot(source.x - x, source.z - z) / this.context.teacher.transitSpeed +
      (2 * (height + 0.1)) / this.context.teacher.transitSpeed +
      (turning > 0.1 ? 6 : 0)
    );
  }
}
