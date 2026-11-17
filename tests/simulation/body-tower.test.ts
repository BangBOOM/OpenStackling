import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';
import { cubeObjects } from '../../src/simulation/world/objects';
import { Simulation } from '../../src/simulation/world/simulation';
import { BodyTowerPlanner } from '../../src/simulation/control/teachers/body-tower';
import { teacherContext } from '../../src/simulation/control/teachers/types';
import type { TaskSpec } from '../../src/simulation/tasks/types';

function fixture(
  sizes: number[],
  positions: { x: number; z: number }[],
  order: Extract<TaskSpec, { kind: 'tower' }>['order'] = 'any',
) {
  const config = resolveConfig({
    scene: {
      objects: sizes.map((size, id) => ({ ...cubeObjects(1, size)[0], id: `object-${id}` })),
    },
    task: { kind: 'tower', order },
  });
  const sim = new Simulation({
    environment: config.environment,
    scene: config.scene.objects.map((object, id) => ({
      ...object,
      position: { ...positions[id], y: config.environment.tableTop + sizes[id] / 2 },
    })),
  });
  return { sim, planner: new BodyTowerPlanner(sim, teacherContext(config)) };
}

test('tower candidate reads are repeatable and rejection only excludes the selected proposal', () => {
  const { sim, planner } = fixture(
    [0.05, 0.05, 0.05],
    [
      { x: -0.3, z: -0.1 },
      { x: 0, z: 0 },
      { x: 0.28, z: -0.1 },
    ],
  );
  try {
    const first = planner.candidates();
    assert.deepEqual(planner.candidates(), first);
    assert(first.length <= 12);
    assert.equal(first[0].support, 1);
    assert.equal(planner.done, false);
    planner.rejected(first[0]);
    assert(!planner.candidates().some((candidate) => candidate.key === first[0].key));
    const accepted = planner.candidates().find((candidate) => candidate.support === 1)!;
    planner.placed(accepted);
    const next = planner.candidates();
    assert.equal(next.length, 1);
    assert.equal(next[0].support, accepted.object);
    assert.notEqual(next[0].object, accepted.object);
    assert.notEqual(next[0].object, accepted.support);
    planner.placed(next[0]);
    assert.equal(planner.done, true);
    assert.deepEqual(planner.candidates(), []);
  } finally {
    sim.dispose();
  }
});

test('mixed-size towers use the broad base and actual next-object dimensions', () => {
  const { sim, planner } = fixture(
    [0.03, 0.07, 0.05],
    [
      { x: -0.3, z: -0.1 },
      { x: 0, z: 0 },
      { x: 0.28, z: -0.1 },
    ],
  );
  try {
    const candidate = planner.candidates()[0];
    assert.equal(candidate.support, 1);
    assert.equal(candidate.object, 2);
    assert(Math.abs(candidate.position.y - (sim.top(1) + 0.025)) < 1e-10);
    planner.placed(candidate);
    const next = planner.candidates()[0];
    assert.equal(next.object, 0);
    assert.equal(next.support, 2);
    assert(Math.abs(next.position.y - (sim.top(2) + 0.015)) < 1e-10);
  } finally {
    sim.dispose();
  }
});

test('ordered towers cannot adopt a central base that violates the required size order', () => {
  for (const order of ['size-ascending', 'size-descending'] as const) {
    const { sim, planner } = fixture(
      [0.03, 0.05, 0.07],
      [
        { x: -0.32, z: -0.16 },
        { x: 0, z: 0 },
        { x: 0.32, z: -0.16 },
      ],
      order,
    );
    try {
      const expectedBase = order === 'size-ascending' ? 0 : 2;
      const candidates = planner.candidates();
      assert(candidates.length > 0);
      assert(
        candidates.every(
          (candidate) => candidate.support === null && candidate.object === expectedBase,
        ),
      );
      assert(candidates.every((candidate) => Number.isFinite(candidate.value)));
      planner.placed(candidates[0]);
      assert(
        planner
          .candidates()
          .every((candidate) => candidate.object === 1 && candidate.support === expectedBase),
      );
    } finally {
      sim.dispose();
    }
  }
});

test('a misplaced base is moved to an unoccupied shared area without consuming candidates', () => {
  const { sim, planner } = fixture(
    [0.05, 0.05],
    [
      { x: -0.3, z: -0.2 },
      { x: 0.3, z: -0.2 },
    ],
  );
  try {
    const candidates = planner.candidates();
    assert(candidates.length > 0 && candidates.length <= 12);
    assert(candidates.every((candidate) => candidate.support === null));
    assert(
      candidates.every(
        (candidate) => Math.abs(candidate.position.x) <= 0.12 && candidate.position.z >= 0,
      ),
    );
    assert.deepEqual(planner.candidates(), candidates);
    planner.placed(candidates[0]);
    assert(planner.candidates().every((candidate) => candidate.support === candidates[0].object));
  } finally {
    sim.dispose();
  }
});

test('a nearby pair tries existing bases and retains relocation when direct plans are rejected', () => {
  const { sim, planner } = fixture(
    [0.05, 0.05],
    [
      { x: 0.08, z: -0.1 },
      { x: 0.28, z: -0.1 },
    ],
  );
  try {
    const snapshot = sim.inspect();
    const first = planner.candidates();
    const direct = first.filter((candidate) => candidate.support !== null);
    assert.equal(direct.length, 2);
    assert.notEqual(first[0].support, null);
    assert.deepEqual(planner.candidates(), first);
    for (const candidate of direct) planner.rejected(candidate);
    const fallback = planner.candidates();
    assert(fallback.length > 0);
    assert(fallback.every((candidate) => candidate.support === null));
    assert.deepEqual(sim.inspect(), snapshot);
    planner.placed(fallback[0]);
    assert(planner.candidates().every((candidate) => candidate.support === fallback[0].object));
  } finally {
    sim.dispose();
  }
});

test('base utility accounts for the remaining opposite-side cubes instead of only the first move', () => {
  const { sim, planner } = fixture(
    [0.05, 0.05, 0.05],
    [
      { x: 0.07683885, z: -0.08413249 },
      { x: 0.267874, z: -0.0021984 },
      { x: -0.24714144, z: -0.05516076 },
    ],
  );
  try {
    const candidates = planner.candidates();
    const central = candidates.find(
      (goal) =>
        goal.object === 2 &&
        goal.support === null &&
        goal.position.x === 0 &&
        goal.position.z === 0,
    )!;
    const left = candidates.find(
      (goal) =>
        goal.object === 2 &&
        goal.support === null &&
        goal.position.x === -0.12 &&
        goal.position.z === 0,
    )!;
    assert(central && left);
    assert(
      central.value > left.value + 0.1,
      'The shared base must receive a meaningful preference for its shorter remaining transports',
    );
  } finally {
    sim.dispose();
  }
});
