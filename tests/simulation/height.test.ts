import { teacherContext } from '../../src/simulation/control/teachers/types';
import { resolveTask } from '../../src/simulation/tasks/registry';
import { createSimulation, fixtureConfig } from './simulation-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';
import { BodyHeightPlanner } from '../../src/simulation/control/teachers/body-height';
import { TaskScore } from '../../src/simulation/tasks/registry';
import { cubeObjects, mixedObjects, halfExtent } from '../../src/simulation/world/objects';
import { Simulation } from '../../src/simulation/world/simulation';

function advance(sim: Simulation, score: TaskScore, seconds = 4) {
  for (let tick = 0; tick < seconds * sim.config.environment.physicsHz; tick++) {
    sim.step();
    score.update();
  }
}

test('height scoring includes initial objects and does not require using a sphere', () => {
  const sim = createSimulation(
    resolveConfig({ scene: { objects: mixedObjects() }, task: { kind: 'max-height' } }),
  );
  try {
    const score = new TaskScore(sim, resolveTask(fixtureConfig(sim)));
    advance(sim, score);
    assert(Math.abs(score.evaluation.heightMeters - 0.14) < 0.002);
    const goal = new BodyHeightPlanner(sim, teacherContext(fixtureConfig(sim)))
      .candidates()
      .find(
        (candidate) =>
          candidate.position.y +
            halfExtent(sim.objects[candidate.object].shape, candidate.rotation) >
          sim.config.environment.tableTop + 0.14,
      );
    assert(goal);
    assert.notEqual(sim.objects[goal.object].shape.kind, 'sphere');
    assert(
      goal.position.y + halfExtent(sim.objects[goal.object].shape, goal.rotation) >
        sim.config.environment.tableTop + 0.14,
    );
  } finally {
    sim.dispose();
  }
});

test('height scoring accepts a bridge with two independent supports', () => {
  const objects = cubeObjects(3, 0.08);
  objects[2].shape = { kind: 'cuboid', size: [0.22, 0.04, 0.08] };
  const sim = createSimulation(resolveConfig({ scene: { objects }, task: { kind: 'max-height' } }));
  try {
    sim.bodies[0].setTranslation({ x: -0.06, y: sim.config.environment.tableTop + 0.04, z: 0.24 });
    sim.bodies[1].setTranslation({ x: 0.06, y: sim.config.environment.tableTop + 0.04, z: 0.24 });
    sim.bodies[2].setTranslation({ x: 0, y: sim.config.environment.tableTop + 0.1, z: 0.24 });
    const score = new TaskScore(sim, resolveTask(fixtureConfig(sim)));
    advance(sim, score);
    const bridge = score.structures.find((structure) => structure.ids.length === 3);
    assert(bridge);
    assert.equal(bridge.tower, null);
    assert(Math.abs(score.evaluation.heightMeters - 0.12) < 0.002);
  } finally {
    sim.dispose();
  }
});

test('a collapsed structure loses its earlier height', () => {
  const objects = cubeObjects(1);
  objects[0].shape = { kind: 'cuboid', size: [0.06, 0.18, 0.06] };
  const sim = createSimulation(resolveConfig({ scene: { objects }, task: { kind: 'max-height' } }));
  try {
    sim.bodies[0].setTranslation({ x: 0.15, y: sim.config.environment.tableTop + 0.09, z: 0.24 });
    const score = new TaskScore(sim, resolveTask(fixtureConfig(sim)));
    advance(sim, score);
    assert(Math.abs(score.evaluation.heightMeters - 0.18) < 0.002);
    sim.bodies[0].applyImpulseAtPoint(
      { x: 0.08, y: 0, z: 0 },
      { x: 0.15, y: sim.config.environment.tableTop + 0.17, z: 0.24 },
    );
    advance(sim, score, 8);
    assert(
      score.evaluation.heightMeters < 0.07,
      JSON.stringify({ evaluation: score.evaluation, final: sim.inspect() }),
    );
  } finally {
    sim.dispose();
  }
});

test('the height teacher reserves time to release and withdraw', () => {
  const sim = createSimulation(
    resolveConfig({
      scene: { objects: mixedObjects() },
      task: { kind: 'max-height' },
      run: { maxSeconds: 8 },
    }),
  );
  try {
    const score = new TaskScore(sim, resolveTask(fixtureConfig(sim)));
    advance(sim, score, 2);
    assert.equal(
      new BodyHeightPlanner(sim, teacherContext(fixtureConfig(sim))).candidates()[0] ?? null,
      null,
    );
  } finally {
    sim.dispose();
  }
});
