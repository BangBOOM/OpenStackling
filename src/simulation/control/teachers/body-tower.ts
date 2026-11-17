import { dimensions, IDENTITY } from '../../world/objects';
import type { Simulation } from '../../world/simulation';
import type { TeacherContext } from './types';
import type { PlacementCandidate, WholeBodyPlanner } from './whole-body-types';

export class BodyTowerPlanner implements WholeBodyPlanner {
  private stack: number[] = [];
  private rejectedKeys = new Set<string>();
  private readonly sizes: number[];
  private readonly order: 'any' | 'size-ascending' | 'size-descending';

  constructor(
    private sim: Simulation,
    context: TeacherContext,
  ) {
    this.sizes = sim.objects.map((object) => dimensions(object.shape)[0]);
    this.order = (context.task as Extract<TeacherContext['task'], { kind: 'tower' }>).order;
  }

  get done() {
    return this.sim.objects.length === 1 || this.stack.length === this.sim.objects.length;
  }

  private eligible(ids: number[]) {
    // Unconstrained mixed-size towers also build broad supports before narrow layers.
    const size =
      this.order === 'size-ascending'
        ? Math.min(...ids.map((id) => this.sizes[id]))
        : Math.max(...ids.map((id) => this.sizes[id]));
    return ids.filter((id) => Math.abs(this.sizes[id] - size) < 1e-8);
  }

  candidates(): PlacementCandidate[] {
    if (this.done) return [];
    const sim = this.sim,
      environment = sim.config.environment,
      ids = sim.objects.map((_, id) => id).filter((id) => !this.stack.includes(id)),
      candidates: PlacementCandidate[] = [];
    const placement = (object: number, support: number, key: string, value: number) => {
      const anchor = sim.bodies[support].translation();
      candidates.push({
        key,
        value,
        object,
        support,
        position: { x: anchor.x, y: sim.top(support) + this.sizes[object] / 2, z: anchor.z },
        rotation: { ...IDENTITY },
      });
    };
    const distance = (object: number, x: number, z: number) => {
      const source = sim.bodies[object].translation();
      return Math.hypot(source.x - x, source.z - z) / environment.tableSize;
    };
    const remainingWork = (base: number, x: number, z: number) => {
      const travel = ids.filter((id) => id !== base).map((id) => distance(id, x, z));
      return travel.reduce((sum, value) => sum + value, 0) + Math.max(0, ...travel);
    };
    if (this.stack.length) {
      const support = this.stack.at(-1)!,
        anchor = sim.bodies[support].translation();
      for (const object of this.eligible(ids))
        placement(
          object,
          support,
          `tower:${support}:${object}`,
          1 - distance(object, anchor.x, anchor.z),
        );
    } else {
      for (const base of this.eligible(ids)) {
        const anchor = sim.bodies[base].translation();
        // A nearby final pair needs no shared staging area for later placements.
        // Keep opposite-side pairs in the shared area to avoid expensive cross-arm searches.
        const sharedReach = ids.every((id) => {
          const x = sim.bodies[id].translation().x;
          return !(anchor.x < -0.12 && x > 0.12) && !(anchor.x > 0.12 && x < -0.12);
        });
        if (
          (ids.length === 2 && sharedReach) ||
          (Math.abs(anchor.x) < 0.12 && anchor.z >= -0.08 && anchor.z <= 0.12)
        )
          for (const object of this.eligible(ids.filter((id) => id !== base)))
            placement(
              object,
              base,
              `tower:${base}:${object}`,
              1 - distance(object, anchor.x, anchor.z),
            );
        const spots = [0, 0.08, 0.16].flatMap((z) => [0, -0.12, 0.12].map((x) => ({ x, z })));
        for (const [spot, p] of spots.entries()) {
          const half = this.sizes[base] / 2;
          if (
            Math.abs(p.x) + half > environment.tableSize / 2 ||
            Math.abs(p.z) + half > environment.tableDepth / 2 ||
            Math.hypot(p.x - anchor.x, p.z - anchor.z) < 0.02 ||
            sim.bodies.some((body, id) => {
              if (id === base) return false;
              const other = body.translation();
              const clearance = Math.max(0.11, half + this.sizes[id] / 2 + 0.06);
              return Math.hypot(p.x - other.x, p.z - other.z) <= clearance;
            })
          )
            continue;
          candidates.push({
            key: `base:${base}:${spot}`,
            value:
              0.25 -
              distance(base, p.x, p.z) -
              remainingWork(base, p.x, p.z) * 0.8 -
              Math.hypot(p.x, p.z) / environment.tableSize,
            object: base,
            support: null,
            position: { x: p.x, y: environment.tableTop + half, z: p.z },
            rotation: { ...IDENTITY },
          });
        }
      }
    }
    return candidates
      .filter((candidate) => !this.rejectedKeys.has(candidate.key))
      .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
      .slice(0, 12);
  }

  placed(goal: PlacementCandidate) {
    if (!this.stack.length && goal.support !== null) this.stack.push(goal.support);
    this.stack.push(goal.object);
    this.rejectedKeys.clear();
  }

  rejected(goal: PlacementCandidate) {
    this.rejectedKeys.add(goal.key);
  }
}
