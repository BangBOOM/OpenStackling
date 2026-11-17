import type { PhysicsCollider, Simulation } from '../world/simulation.js';
export type Structure = {
  ids: number[];
  tower: number[] | null;
  stable: boolean;
  stableSeconds: number;
  height: number;
  key: string;
};
export function contact(sim: Simulation, a: PhysicsCollider, b: PhysicsCollider, vertical = false) {
  return sim.frame.pairs.some(
    (pair) =>
      ((pair.a === a.id && pair.b === b.id) || (pair.a === b.id && pair.b === a.id)) &&
      pair.manifolds.some(
        (manifold) =>
          (!vertical || Math.abs(manifold.normal.y) >= 0.2) &&
          manifold.points.some((point) => point.impulse > 0 || point.distance <= 0.0002),
      ),
  );
}
export function inspectStructures(sim: Simulation): Structure[] {
  const n = sim.bodies.length;
  const adjacent = Array.from({ length: n }, () => [] as number[]);
  const below = Array.from({ length: n }, () => [] as number[]);
  const table = sim.bodies.map(
    (b, id) =>
      sim.bottom(id) >= sim.config.environment.tableTop - 0.004 &&
      contact(sim, b.collider(0), sim.table, true),
  );
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      if (!contact(sim, sim.bodies[a].collider(0), sim.bodies[b].collider(0))) continue;
      adjacent[a].push(b);
      adjacent[b].push(a);
      if (contact(sim, sim.bodies[a].collider(0), sim.bodies[b].collider(0), true)) {
        const ay = sim.bodies[a].translation().y,
          by = sim.bodies[b].translation().y;
        if (ay > by + 0.001) below[a].push(b);
        else if (by > ay + 0.001) below[b].push(a);
      }
    }
  const visited = new Set<number>();
  const result: Structure[] = [];
  for (let root = 0; root < n; root++) {
    if (visited.has(root)) continue;
    const ids: number[] = [],
      pending = [root];
    visited.add(root);
    while (pending.length) {
      const id = pending.pop()!;
      ids.push(id);
      for (const other of adjacent[id])
        if (!visited.has(other)) {
          visited.add(other);
          pending.push(other);
        }
    }
    ids.sort((a, b) => sim.bodies[a].translation().y - sim.bodies[b].translation().y || a - b);
    const grounded = new Set(ids.filter((id) => table[id]));
    for (let pass = 0; pass < ids.length; pass++)
      for (const id of ids) if (adjacent[id].some((b) => grounded.has(b))) grounded.add(id);
    const stable = ids.every((id) => {
      const body = sim.bodies[id],
        v = body.linvel(),
        w = body.angvel(),
        p = body.translation();
      return (
        grounded.has(id) &&
        sim.bottom(id) >= sim.config.environment.tableTop - 0.004 &&
        Math.hypot(v.x, v.y, v.z) < 0.025 &&
        Math.hypot(w.x, w.y, w.z) < 0.05 &&
        !sim.touching(body) &&
        Math.abs(p.x) + sim.extent(id, { x: 1, y: 0, z: 0 }) <=
          sim.config.environment.tableSize / 2 + 0.001 &&
        Math.abs(p.z) + sim.extent(id, { x: 0, y: 0, z: 1 }) <=
          sim.config.environment.tableDepth / 2 + 0.001
      );
    });
    const tower =
      table[ids[0]] &&
      ids.every((id, i) =>
        i === 0
          ? below[id].length === 0
          : !table[id] && below[id].length === 1 && below[id][0] === ids[i - 1],
      ) &&
      ids.every((id, i) =>
        adjacent[id].every((other) => other === ids[i - 1] || other === ids[i + 1]),
      )
        ? ids
        : null;
    const key = ids.map((id) => `${id}:${table[id] ? 't' : ''}:${below[id].join(',')}`).join(';');
    result.push({
      ids,
      tower,
      stable,
      stableSeconds: 0,
      height: Math.max(...ids.map((id) => sim.top(id))) - sim.config.environment.tableTop,
      key,
    });
  }
  return result;
}
export class StructureTracker {
  private times = new Map<string, number>();
  update(sim: Simulation) {
    const structures = inspectStructures(sim),
      next = new Map<string, number>();
    for (const structure of structures) {
      structure.stableSeconds = structure.stable
        ? (this.times.get(structure.key) ?? 0) + sim.dt
        : 0;
      next.set(structure.key, structure.stableSeconds);
    }
    this.times = next;
    return structures;
  }
  reset() {
    this.times.clear();
  }
}
