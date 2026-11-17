import { createSimulation } from './simulation-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';
import { cubeObjects } from '../../src/simulation/world/objects';

import { countDefinition } from '../../src/simulation/tasks/partition-count';
import { colorDefinition } from '../../src/simulation/tasks/partition-color';
import type { Structure } from '../../src/simulation/tasks/structures';
import { BodyPartitionPlanner } from '../../src/simulation/control/teachers/body-partition';

function tower(ids: number[]): Structure {
  return {
    ids,
    tower: ids,
    stable: true,
    stableSeconds: 3,
    height: ids.length * 0.09,
    key: ids.join(','),
  };
}

test('count partitions match repeated target slots without counting extra towers', () => {
  const config = resolveConfig({
    scene: { objects: cubeObjects(8) },
    task: { kind: 'partition-count', counts: [2, 2, 4] },
  });
  const sim = createSimulation(config);
  const partial = countDefinition.evaluate(
    sim,
    [tower([0, 1]), tower([2, 3]), tower([4, 5]), tower([6, 7])],
    config.task,
  );
  assert.equal(partial.success, false);
  assert.equal(partial.groups, 2);
  assert.equal(partial.completed, 4);
  const complete = countDefinition.evaluate(
    sim,
    [tower([6, 7]), tower([0, 1, 2, 3]), tower([4, 5])],
    config.task,
  );
  assert.equal(complete.success, true);
  assert.equal(complete.completed, 8);
  const bridge = tower([0, 1, 2, 3]);
  bridge.tower = null;
  assert.equal(
    countDefinition.evaluate(sim, [bridge, tower([4, 5]), tower([6, 7])], config.task).success,
    false,
  );
  sim.dispose();
});

test('color partitions require one complete, pure tower per color', () => {
  const config = resolveConfig({
    scene: { objects: cubeObjects(8, 0.05, [4, 2, 1, 1]) },
    task: { kind: 'partition-color' },
  });
  const sim = createSimulation(config);
  const split = colorDefinition.evaluate(
    sim,
    [tower([0, 1]), tower([2, 3]), tower([4, 5]), tower([6]), tower([7])],
    config.task,
  );
  assert.equal(split.success, false);
  assert.equal(split.groups, 3);
  assert.equal(split.completed, 4);
  const mixed = colorDefinition.evaluate(
    sim,
    [tower([0, 1, 2, 4]), tower([3, 5]), tower([6]), tower([7])],
    config.task,
  );
  assert.equal(mixed.completed, 2);
  const complete = colorDefinition.evaluate(
    sim,
    [tower([0, 1, 2, 3]), tower([4, 5]), tower([6]), tower([7])],
    config.task,
  );
  assert.equal(complete.success, true);
  assert.equal(complete.totalGroups, 4);
  sim.dispose();
});

test('partition prompt templates describe the selected target in both languages', () => {
  const config = resolveConfig({
    scene: { objects: cubeObjects(8) },
    task: { kind: 'partition-count', counts: [4, 4] },
  });
  assert.match(countDefinition.describe(config.task, config.scene, 480), /\[4, 4\]/);
  config.task.language = 'zh';
  assert.match(countDefinition.describe(config.task, config.scene, 480), /全部 8 个方块/);
  const color = { kind: 'partition-color', language: 'en', stableSeconds: 3 } as const;
  assert.match(
    colorDefinition.describe(color, config.scene, 480),
    /exactly one tower for each color/,
  );
  assert.match(
    colorDefinition.describe({ ...color, language: 'zh' }, config.scene, 480),
    /不同颜色不能混堆/,
  );
});

test('already separated singleton groups require no teacher movement', () => {
  for (const task of [
    { kind: 'partition-color' },
    { kind: 'partition-count', counts: [1, 1, 1] },
  ] as const) {
    const config = resolveConfig({
      scene: { objects: cubeObjects(3) },
      task: task.kind === 'partition-count' ? { kind: task.kind, counts: [...task.counts] } : task,
    });
    const sim = createSimulation(config);
    const planner = new BodyPartitionPlanner(sim, config.task as any);
    assert.deepEqual(planner.candidates(), []);
    assert.equal(planner.failure, undefined);
    assert.equal(planner.done, true);
    sim.dispose();
  }
});
