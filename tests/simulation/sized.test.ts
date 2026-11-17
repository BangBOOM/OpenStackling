import { teacherContext } from '../../src/simulation/control/teachers/types';
import { createSimulation, fixtureConfig } from './simulation-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';

import {
  sizedObjects,
  randomSizedObjects,
  randomMixedObjects,
  scaledObjects,
  dimensions,
} from '../../src/simulation/world/objects';
import { towerDefinition } from '../../src/simulation/tasks/tower';
import type { Structure } from '../../src/simulation/tasks/structures';
import { BodyTowerPlanner } from '../../src/simulation/control/teachers/body-tower';

test('generated inventories preserve counts and seeds while varying sizes and shape counts', () => {
  const counts = new Set<string>();
  for (const seed of [0, 1, 2, 3, 42, 2026]) {
    const sized = randomSizedObjects(8, seed);
    assert.equal(sized.length, 8);
    assert.deepEqual(sized, randomSizedObjects(8, seed));
    assert.equal(new Set(sized.map((o) => o.shape.kind === 'cuboid' && o.shape.size[0])).size, 8);
    resolveConfig({ scene: { objects: scaledObjects(sized, 5 / 9) } });
    const mixed = randomMixedObjects(12, seed);
    assert.equal(mixed.length, 12);
    assert.deepEqual(mixed, randomMixedObjects(12, seed));
    counts.add(
      JSON.stringify(
        mixed.reduce<Record<string, number>>((all, o) => {
          all[o.shape.kind] = (all[o.shape.kind] ?? 0) + 1;
          return all;
        }, {}),
      ),
    );
    resolveConfig({ scene: { objects: mixed }, task: { kind: 'max-height' } });
  }
  assert(counts.size > 1);
  assert.notDeepEqual(randomSizedObjects(5, 42), randomSizedObjects(5, 2026));
  assert.notDeepEqual(randomMixedObjects(8, 42), randomMixedObjects(8, 2026));
});
const structure = (ids: number[], tower: number[] | null = ids): Structure => ({
  ids,
  tower,
  stable: true,
  stableSeconds: 3,
  height: 0.225,
  key: ids.join(','),
});

test('sized tower progress matches the complete sorted target prefix', () => {
  const sim = createSimulation(
    resolveConfig({
      scene: { objects: sizedObjects([0.06, 0.075, 0.09]) },
      task: { kind: 'tower', order: 'size-descending' },
    }),
  );
  try {
    const evaluate = (ids: number[]) =>
      towerDefinition.evaluate(sim, [structure(ids)], fixtureConfig(sim).task);
    assert.equal(evaluate([2, 0, 1]).completed, 1);
    assert.equal(evaluate([1, 0]).completed, 0);
    assert.equal(evaluate([2, 1]).completed, 2);
    assert.equal(evaluate([2, 1, 0]).success, true);
    assert.equal(
      towerDefinition.evaluate(sim, [structure([2]), structure([1, 0])], fixtureConfig(sim).task)
        .success,
      false,
    );
    assert.equal(
      towerDefinition.evaluate(sim, [structure([2, 1, 0], null)], fixtureConfig(sim).task)
        .completed,
      0,
    );
    const ascending = {
      ...fixtureConfig(sim).task,
      kind: 'tower' as const,
      order: 'size-ascending' as const,
    };
    assert.equal(towerDefinition.evaluate(sim, [structure([0, 1, 2])], ascending).success, true);
    const any = { ...ascending, order: 'any' as const };
    assert.equal(towerDefinition.evaluate(sim, [structure([1, 0, 2])], any).success, true);
  } finally {
    sim.dispose();
  }
});

test('equal-sized cubes are interchangeable in a sorted tower', () => {
  const sim = createSimulation(
    resolveConfig({
      scene: { objects: sizedObjects([0.06, 0.075, 0.075]) },
      task: { kind: 'tower', order: 'size-descending' },
    }),
  );
  try {
    assert.equal(
      towerDefinition.evaluate(sim, [structure([1, 2, 0])], fixtureConfig(sim).task).success,
      true,
    );
    assert.equal(
      towerDefinition.evaluate(sim, [structure([2, 1, 0])], fixtureConfig(sim).task).success,
      true,
    );
  } finally {
    sim.dispose();
  }
});

test('ordered planner retries cannot replace the required base with another size', () => {
  for (const order of ['size-ascending', 'size-descending'] as const) {
    const sim = createSimulation(
      resolveConfig({
        scene: { objects: sizedObjects([0.06, 0.075, 0.09]) },
        task: { kind: 'tower', order },
      }),
    );
    try {
      const planner = new BodyTowerPlanner(sim, teacherContext(fixtureConfig(sim)));
      const candidates = planner.candidates();
      assert(candidates.length > 0);
      const base = order === 'size-ascending' ? 0 : 2;
      for (const goal of candidates) {
        if (goal.support === null) assert.equal(goal.object, base);
        else {
          assert.equal(goal.support, base);
          assert.equal(goal.object, 1);
        }
      }
      candidates.forEach((candidate) => planner.rejected(candidate));
      assert.deepEqual(planner.candidates(), []);
    } finally {
      sim.dispose();
    }
  }
});

test('generated inventories use the declared scale and require the configured generator', async () => {
  const { generatedObjects } = await import('../../src/simulation/scene');
  for (const kind of ['random-mixed', 'random-sized'] as const) {
    const reference =
      kind === 'random-mixed' ? randomMixedObjects(8, 2026) : randomSizedObjects(8, 2026, 0.54);
    assert.throws(
      () => generatedObjects({ kind, version: 1 as any, count: 8 }, 2026, 0.54),
      /Unsupported scene generator version/,
    );
    const human = generatedObjects({ kind, version: 2, count: 8 }, 2026, 0.3);
    human.forEach((object, i) => {
      assert.deepEqual({ ...object, shape: reference[i].shape }, reference[i]);
      dimensions(object.shape).forEach((size, axis) =>
        assert(Math.abs(size - (dimensions(reference[i].shape)[axis] * 5) / 9) < 1e-14),
      );
    });
  }
});
