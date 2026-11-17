import type { Simulation } from '../../world/simulation';
import { dimensions, IDENTITY } from '../../world/objects';
import type { Vec3 } from '../../world/types';
import type { TaskSpec } from '../../tasks/types';
import type { PlacementCandidate, WholeBodyPlanner } from './whole-body-types';

type Group = { count: number; color?: string; stack: number[] };

export class BodyPartitionPlanner implements WholeBodyPlanner {
  private groups: Group[];
  private rejectedKeys = new Set<string>();
  private relocatedGroups = new Set<number>();
  private stagedObjects = new Set<number>();
  private readonly size: number;
  private readonly spacing: number;
  private readonly slots: Vec3[];
  private readonly stagingSlots: Vec3[];
  failure?: string;

  constructor(
    private sim: Simulation,
    task: Extract<TaskSpec, { kind: 'partition-count' | 'partition-color' }>,
  ) {
    this.groups =
      task.kind === 'partition-count'
        ? task.counts.map((count) => ({ count, stack: [] }))
        : [...new Set(sim.objects.map((object) => object.color))].map((color) => ({
            color,
            count: sim.objects.filter((object) => object.color === color).length,
            stack: [],
          }));
    this.size = dimensions(sim.objects[0].shape)[0];
    const environment = sim.config.environment;
    this.spacing = Math.max(
      this.size + 0.1,
      environment.robot.gap[1] + environment.robot.fingerWidth * 2 + 0.05,
    );
    const width = Math.min(0.28, environment.tableSize / 2 - this.size / 2 - 0.06);
    const depth = Math.min(0.16, environment.tableDepth / 2 - this.size / 2 - 0.06);
    this.slots = [-0.04, depth].flatMap((z) =>
      [-width, 0, width].map((x) => ({ x, y: environment.tableTop + this.size / 2, z })),
    );
    const stagingWidth = Math.min(0.18, width);
    const stagingDepth = Math.min(0.24, environment.tableDepth / 2 - this.size / 2 - 0.06);
    this.stagingSlots = [-stagingDepth, -0.04, depth].flatMap((z) =>
      [-stagingWidth, 0, stagingWidth].map((x) => ({
        x,
        y: environment.tableTop + this.size / 2,
        z,
      })),
    );
    const assigned = new Set<number>();
    // Singleton groups already satisfy their task and should never be moved gratuitously.
    for (const group of [...this.groups].sort((a, b) => a.count - b.count)) {
      const index = this.groups.indexOf(group);
      const members = this.members(group, assigned).sort((a, b) => {
        const p = sim.bodies[a].translation(),
          q = sim.bodies[b].translation();
        return (
          this.futureWork(index, a, p, 1, false) +
            Math.hypot(p.x, p.z) * 0.35 -
            this.futureWork(index, b, q, 1, false) -
            Math.hypot(q.x, q.z) * 0.35 || a - b
        );
      });
      const base = members.find((id) => {
        if (group.count === 1) return true;
        const p = sim.bodies[id].translation();
        return Math.abs(p.x) <= 0.32 && p.z >= -0.14 && p.z <= 0.18 && this.separated(p, group);
      });
      if (base !== undefined) {
        group.stack.push(base);
        assigned.add(base);
      }
    }
  }

  get done() {
    return this.groups.every((group) => group.stack.length === group.count);
  }

  private members(group: Group, assigned: Set<number>) {
    return this.sim.objects
      .map((_, id) => id)
      .filter(
        (id) => !assigned.has(id) && (!group.color || this.sim.objects[id].color === group.color),
      );
  }

  private separated(position: Vec3, own: Group) {
    return this.groups.every((group) => {
      if (group === own || !group.stack.length) return true;
      const other = this.sim.bodies[group.stack[0]].translation();
      return Math.hypot(position.x - other.x, position.z - other.z) >= this.spacing;
    });
  }

  private free(position: Vec3, object: number, group: Group) {
    return (
      this.separated(position, group) &&
      this.sim.bodies.every((body, id) => {
        if (id === object) return true;
        const p = body.translation();
        return Math.hypot(position.x - p.x, position.z - p.z) >= this.size + 0.045;
      })
    );
  }

  private candidate(group: number, object: number, support: number | null, position: Vec3) {
    const source = this.sim.bodies[object].translation();
    const hands = this.sim.arms.map((arm) => arm.pose());
    const reach = Math.min(
      ...hands.map((hand) => Math.hypot(hand.x - source.x, hand.z - source.z)),
    );
    const travel = Math.hypot(position.x - source.x, position.z - source.z);
    const relocation = this.groups[group].stack.includes(object);
    const goal: PlacementCandidate = {
      key: `${group}:${object}:${support ?? 'table'}:${position.x.toFixed(4)}:${position.z.toFixed(4)}`,
      object,
      support,
      position,
      rotation: { ...IDENTITY },
      value:
        1 -
        travel * 0.5 -
        reach * 0.25 -
        this.futureWork(
          group,
          object,
          position,
          support === null ? 1 : this.groups[group].stack.length + 1,
        ) *
          0.8 -
        (relocation ? 0.5 : 0) +
        (this.groups[group].stack.length + 1 === this.groups[group].count ? 0.1 : 0),
    };
    return goal;
  }

  private futureWork(
    group: number,
    object: number,
    position: Vec3,
    placed: number,
    crowding = true,
  ) {
    const assigned = new Set(this.groups.flatMap((entry) => entry.stack));
    const clearance = this.size + this.sim.config.environment.robot.fingerLength + 0.02;
    return this.members(this.groups[group], assigned)
      .filter((id) => id !== object)
      .map((id) => {
        const source = this.sim.bodies[id].translation();
        const distance = Math.hypot(source.x - position.x, source.z - position.z);
        // Very short transports can leave no room for the open fingers to approach a source.
        return distance + (crowding ? Math.max(0, clearance - distance) * 2 : 0);
      })
      .sort((a, b) => a - b)
      .slice(0, this.groups[group].count - placed)
      .reduce((sum, distance) => sum + distance, 0);
  }

  private stagingCandidates(assigned: Set<number>) {
    const out: PlacementCandidate[] = [];
    for (const [index, group] of this.groups.entries()) {
      if (!group.stack.length || group.stack.length === group.count) continue;
      const base = this.sim.bodies[group.stack[0]].translation();
      for (const object of this.members(group, assigned)) {
        if (this.stagedObjects.has(object)) continue;
        const source = this.sim.bodies[object].translation();
        for (const slot of this.stagingSlots) {
          const remaining = Math.hypot(slot.x - base.x, slot.z - base.z);
          if (!this.free(slot, object, group) || remaining < this.spacing) continue;
          const travel = Math.hypot(slot.x - source.x, slot.z - source.z);
          const benefit = Math.hypot(source.x - base.x, source.z - base.z) - remaining;
          if (benefit < 0.08 || travel < 0.08) continue;
          const goal = this.candidate(index, object, null, { ...slot });
          goal.key += ':stage';
          goal.value = benefit - travel * 0.5;
          if (!this.rejectedKeys.has(goal.key)) out.push(goal);
        }
      }
    }
    return out.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key)).slice(0, 12);
  }

  candidates(): PlacementCandidate[] {
    const assigned = new Set(this.groups.flatMap((group) => group.stack));
    const perGroup = this.groups.map((group, index) => {
      if (group.stack.length === group.count) return [];
      const out: PlacementCandidate[] = [];
      const pending = this.members(group, assigned);
      if (group.stack.length) {
        const support = group.stack.at(-1)!,
          base = this.sim.bodies[group.stack[0]].translation();
        for (const object of pending)
          out.push(
            this.candidate(index, object, support, {
              x: base.x,
              y: this.sim.top(support) + this.size / 2,
              z: base.z,
            }),
          );
      }
      // A single-cube base can be relocated when its current column is obstructed.
      const bases =
        group.stack.length === 1 && !this.relocatedGroups.has(index)
          ? [group.stack[0]]
          : group.stack.length
            ? []
            : pending;
      for (const object of bases)
        for (const slot of this.slots)
          if (this.free(slot, object, group)) {
            if (group.stack.length) {
              const current = this.sim.bodies[object].translation();
              const benefit =
                this.futureWork(index, object, current, 1) -
                this.futureWork(index, object, slot, 1);
              if (Math.hypot(slot.x - current.x, slot.z - current.z) < 0.08 || benefit < 0.025)
                continue;
            }
            out.push(this.candidate(index, object, null, { ...slot }));
          }
      return out
        .filter((goal) => !this.rejectedKeys.has(goal.key))
        .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
    });
    const out: PlacementCandidate[] = [];
    for (let rank = 0; out.length < 12; rank++) {
      let found = false;
      for (const candidates of perGroup) {
        if (candidates[rank]) {
          out.push(candidates[rank]);
          found = true;
          if (out.length === 12) break;
        }
      }
      if (!found) break;
    }
    // A real table release lets the other arm continue an otherwise unreachable transport.
    // Only try it after direct placements and base relocations have been exhausted.
    if (!out.length) out.push(...this.stagingCandidates(assigned));
    this.failure =
      !out.length && !this.done ? 'No remaining partition placement candidates' : undefined;
    return out;
  }

  placed(goal: PlacementCandidate) {
    const group = this.groups[Number(goal.key.split(':')[0])];
    if (goal.key.endsWith(':stage')) {
      this.stagedObjects.add(goal.object);
    } else if (goal.support === null) {
      if (group.stack.length) this.relocatedGroups.add(Number(goal.key.split(':')[0]));
      group.stack = [goal.object];
    } else group.stack.push(goal.object);
    this.rejectedKeys.clear();
    this.failure = undefined;
  }

  rejected(goal: PlacementCandidate) {
    this.rejectedKeys.add(goal.key);
  }
}
