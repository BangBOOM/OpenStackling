import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';
import { cubeObjects } from '../../src/simulation/world/objects';
import { Simulation } from '../../src/simulation/world/simulation';
import type { TaskSpec } from '../../src/simulation/tasks/types';
import { BodyPartitionPlanner } from '../../src/simulation/control/teachers/body-partition';

function fixture(
  task: Extract<TaskSpec, { kind: 'partition-count' | 'partition-color' }>,
  count: number,
  colors?: number[],
  positions?: { x: number; z: number }[],
) {
  const objects = cubeObjects(count, 0.05, colors);
  const environment = resolveConfig({ scene: { objects }, task }).environment;
  const sim = new Simulation({
    environment,
    scene: objects.map((object, id) => ({
      ...object,
      position: {
        x: positions?.[id].x ?? [-0.28, -0.1, 0.1, 0.28][id % 4],
        y: environment.tableTop + 0.025,
        z: positions?.[id].z ?? (id < 4 ? -0.1 : 0.1),
      },
    })),
  });
  return { sim, planner: new BodyPartitionPlanner(sim, task) };
}
const common = { language: 'en', stableSeconds: 3 } as const;

test('partition candidate reads preserve inventory and rejection advances alternatives', () => {
  const { sim, planner } = fixture({ ...common, kind: 'partition-count', counts: [2, 2, 2, 2] }, 8);
  try {
    const first = planner.candidates();
    assert(first.length > 0 && first.length <= 12);
    assert.deepEqual(planner.candidates(), first);
    assert(new Set(first.map((goal) => goal.key.split(':')[0])).size >= 2);
    planner.rejected(first[0]);
    const next = planner.candidates();
    assert(!next.some((goal) => goal.key === first[0].key));
    assert.equal(planner.done, false);
    assert(next.length > 0);
  } finally {
    sim.dispose();
  }
});

test('count partition feedback fills exact tower capacities without reusing a placed cube', () => {
  const { sim, planner } = fixture({ ...common, kind: 'partition-count', counts: [3, 3, 2] }, 8);
  try {
    const placed = new Set<number>();
    const additions = new Map<number, number>();
    for (let i = 0; !planner.done && i < 8; i++) {
      const goal = planner.candidates().find((candidate) => candidate.support !== null)!;
      assert(goal, 'The fixture has existing bases for all three groups');
      assert(!placed.has(goal.object));
      const group = Number(goal.key.split(':')[0]);
      additions.set(group, (additions.get(group) ?? 0) + 1);
      placed.add(goal.object);
      planner.placed(goal);
      assert(!planner.candidates().some((candidate) => candidate.object === goal.object));
    }
    assert.equal(planner.done, true);
    assert.deepEqual(
      [...additions.entries()].sort((a, b) => a[0] - b[0]),
      [
        [0, 2],
        [1, 2],
        [2, 1],
      ],
    );
    assert.equal(placed.size, 5);
    assert.deepEqual(planner.candidates(), []);
  } finally {
    sim.dispose();
  }
});

test('color partition candidates never place a cube on a different color', () => {
  const { sim, planner } = fixture({ ...common, kind: 'partition-color' }, 8, [2, 2, 2, 2]);
  try {
    for (let i = 0; !planner.done && i < 8; i++) {
      const goals = planner.candidates();
      for (const goal of goals)
        if (goal.support !== null)
          assert.equal(sim.objects[goal.object].color, sim.objects[goal.support].color);
      const goal = goals.find((candidate) => candidate.support !== null)!;
      assert(goal);
      planner.placed(goal);
    }
    assert.equal(planner.done, true);
  } finally {
    sim.dispose();
  }
});

test('singleton groups remain untouched and relocated bases have gripper clearance', () => {
  const singleton = fixture({ ...common, kind: 'partition-count', counts: [1, 1, 1] }, 3);
  try {
    assert.equal(singleton.planner.done, true);
    assert.deepEqual(singleton.planner.candidates(), []);
  } finally {
    singleton.sim.dispose();
  }
  const { sim, planner } = fixture(
    { ...common, kind: 'partition-color' },
    4,
    [2, 2],
    [
      { x: -0.32, z: -0.12 },
      { x: 0.28, z: -0.05 },
      { x: -0.12, z: 0.14 },
      { x: 0.12, z: 0.14 },
    ],
  );
  try {
    const rejected = new Set<string>();
    let relocation;
    for (let i = 0; i < 6 && !relocation; i++) {
      const goals = planner.candidates();
      relocation = goals.find((goal) => goal.support === null);
      for (const goal of goals)
        if (goal.support !== null) {
          planner.rejected(goal);
          rejected.add(goal.key);
        }
    }
    assert(relocation);
    for (let id = 0; id < sim.objects.length; id++) {
      if (id === relocation.object) continue;
      const p = sim.bodies[id].translation();
      assert(Math.hypot(p.x - relocation.position.x, p.z - relocation.position.z) >= 0.095);
    }
    const group = relocation.key.split(':')[0];
    planner.placed(relocation);
    assert(
      !planner
        .candidates()
        .some((goal) => goal.support === null && goal.key.split(':')[0] === group),
    );
  } finally {
    sim.dispose();
  }
});

test('count partition reserves bases using nearby cohorts instead of stranding the last cross-table cube', () => {
  const { sim, planner } = fixture(
    { ...common, kind: 'partition-count', counts: [2, 2] },
    4,
    undefined,
    [
      { x: 0.07683885, z: -0.08413249 },
      { x: 0.267874, z: -0.0021984 },
      { x: -0.24714144, z: -0.05516076 },
      { x: 0.27776073, z: -0.07524269 },
    ],
  );
  try {
    const goals = planner.candidates();
    assert.deepEqual(
      [
        ...new Set(goals.filter((goal) => goal.support !== null).map((goal) => goal.support)),
      ].sort(),
      [0, 1],
    );
    assert(
      !goals.some(
        (goal) => goal.support === null && goal.object === 2 && goal.position.x === -0.28,
      ),
    );
    const rightPair = goals.find((goal) => goal.object === 3 && goal.support === 1)!;
    assert(rightPair);
    planner.placed(rightPair);
    assert(planner.candidates().some((goal) => goal.object === 2 && goal.support === 0));
  } finally {
    sim.dispose();
  }
});

test('base relocation must meaningfully shorten the remaining work and retain spacing', () => {
  const { sim, planner } = fixture(
    { ...common, kind: 'partition-color' },
    4,
    [2, 2],
    [
      { x: -0.32, z: -0.12 },
      { x: 0.28, z: -0.05 },
      { x: -0.12, z: 0.14 },
      { x: 0.12, z: 0.14 },
    ],
  );
  try {
    const relocations = planner.candidates().filter((goal) => goal.support === null);
    assert(relocations.length > 0);
    for (const goal of relocations) {
      const current = sim.bodies[goal.object].translation();
      const partner = sim.objects.findIndex(
        (object, id) => id !== goal.object && object.color === sim.objects[goal.object].color,
      );
      const source = sim.bodies[partner].translation();
      const before = Math.hypot(current.x - source.x, current.z - source.z);
      const after = Math.hypot(goal.position.x - source.x, goal.position.z - source.z);
      assert(before - after >= 0.025);
      assert(Math.hypot(goal.position.x - current.x, goal.position.z - current.z) >= 0.08);
    }
  } finally {
    sim.dispose();
  }
});

test('a crowded pair can move its base farther away to open a physical grasp corridor', () => {
  const { sim, planner } = fixture(
    { ...common, kind: 'partition-color' },
    2,
    [2],
    [
      { x: 0, z: -0.01 },
      { x: 0.015, z: 0.055 },
    ],
  );
  try {
    const relocation = planner
      .candidates()
      .find(
        (goal) =>
          goal.support === null &&
          goal.object === 0 &&
          goal.position.x === 0 &&
          goal.position.z === 0.16,
      )!;
    assert(
      relocation,
      'Relocation must account for grasp clearance even when transport distance increases',
    );
    const source = sim.bodies[1].translation(),
      base = sim.bodies[0].translation();
    const before = Math.hypot(source.x - base.x, source.z - base.z);
    const after = Math.hypot(source.x - relocation.position.x, source.z - relocation.position.z);
    assert(after > before);
    assert(after >= 0.095, 'The original physical free-space requirement remains enforced');
    assert(Math.hypot(relocation.position.x - base.x, relocation.position.z - base.z) >= 0.08);
  } finally {
    sim.dispose();
  }
});

test('exhausted cross-table transport stages a pending cube once without replacing its tower base', () => {
  const { sim, planner } = fixture(
    { ...common, kind: 'partition-color' },
    2,
    [2],
    [
      { x: 0.28, z: -0.04 },
      { x: -0.377, z: -0.075 },
    ],
  );
  try {
    const initial = planner.candidates();
    assert(initial.length > 0);
    assert(initial.every((goal) => !goal.key.endsWith(':stage')));
    let candidates = initial;
    for (
      let attempt = 0;
      attempt < 8 && !candidates.some((goal) => goal.key.endsWith(':stage'));
      attempt++
    ) {
      for (const goal of candidates) planner.rejected(goal);
      candidates = planner.candidates();
    }
    assert(candidates.length > 0);
    assert(candidates.every((goal) => goal.key.endsWith(':stage')));
    assert.deepEqual(
      planner.candidates(),
      candidates,
      'Reading a staging option does not consume it',
    );
    const base = sim.bodies[0].translation(),
      source = sim.bodies[1].translation();
    for (const goal of candidates) {
      assert.equal(goal.object, 1);
      assert.equal(goal.support, null);
      const remaining = Math.hypot(goal.position.x - base.x, goal.position.z - base.z);
      assert(remaining >= 0.164, 'The original gripper spacing also applies to the own tower');
      assert(Math.hypot(source.x - base.x, source.z - base.z) - remaining >= 0.08);
      assert(Math.hypot(goal.position.x - source.x, goal.position.z - source.z) >= 0.08);
    }
    const staging = candidates[0];
    sim.bodies[staging.object].setTranslation(staging.position);
    planner.placed(staging);
    assert.equal(planner.done, false, 'A table staging placement is not task progress');
    assert.deepEqual(sim.bodies[0].translation(), base);
    assert(planner.candidates().some((goal) => goal.object === 1 && goal.support === 0));
    for (let attempt = 0; attempt < 8 && planner.candidates().length; attempt++) {
      const remaining = planner.candidates();
      assert(remaining.every((goal) => !goal.key.endsWith(':stage')));
      for (const goal of remaining) planner.rejected(goal);
    }
    assert.deepEqual(planner.candidates(), [], 'An object cannot enter an unbounded staging loop');
  } finally {
    sim.dispose();
  }
});
