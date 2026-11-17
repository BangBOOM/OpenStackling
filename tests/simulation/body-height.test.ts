import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';
import { cubeObjects, halfExtent, type ShapeSpec } from '../../src/simulation/world/objects';
import { Simulation } from '../../src/simulation/world/simulation';
import { BodyHeightPlanner } from '../../src/simulation/control/teachers/body-height';
import { teacherContext } from '../../src/simulation/control/teachers/types';

function fixture(shapes: ShapeSpec[], seconds = 240) {
  const objects = cubeObjects(shapes.length).map((object, i) => ({ ...object, shape: shapes[i] }));
  const config = resolveConfig({
    task: { kind: 'max-height' },
    scene: { objects },
    run: { maxSeconds: seconds },
  });
  const sim = new Simulation({
    environment: config.environment,
    scene: objects.map((object, i) => ({
      ...object,
      position: {
        x: -0.3 + (i % 4) * 0.15,
        y: config.environment.tableTop + halfExtent(object.shape, object.rotation),
        z: -0.05 + Math.floor(i / 4) * 0.15,
      },
    })),
  });
  for (let i = 0; i < 180; i++) sim.step();
  return { sim, planner: new BodyHeightPlanner(sim, teacherContext(config)) };
}

test('height candidates can stand a long cuboid on its narrow face without moving the world', () => {
  const { sim, planner } = fixture([
    { kind: 'cuboid', size: [0.08, 0.06, 0.08] },
    { kind: 'cuboid', size: [0.16, 0.035, 0.035] },
  ]);
  try {
    const before = sim.inspect();
    const candidates = planner.candidates();
    assert(candidates.length > 0 && candidates.length <= 12);
    const upright = candidates.find(
      (goal) =>
        goal.object === 1 &&
        goal.support === 0 &&
        halfExtent(sim.objects[1].shape, goal.rotation) > 0.079,
    );
    assert(upright, 'A tall feasible orientation must remain available to whole-body execution');
    assert(Math.abs(upright.position.y - sim.top(0) - 0.08) < 1e-6);
    assert(upright.value > 0.7 && upright.value <= 1);
    assert.deepEqual(sim.inspect(), before);
    assert.equal(planner.allowPartial, true);
  } finally {
    sim.dispose();
  }
});

test('height geometry rejects unsupported corners on a cylinder and skips spheres', () => {
  const { sim, planner } = fixture([
    { kind: 'cylinder', radius: 0.025, height: 0.04 },
    { kind: 'cuboid', size: [0.04, 0.04, 0.04] },
    { kind: 'sphere', radius: 0.02 },
  ]);
  try {
    assert.deepEqual(planner.candidates(), []);
    assert.equal(planner.done, true);
  } finally {
    sim.dispose();
  }
});

test('height planning reserves time for release and leaves deadline scoring to the runner', () => {
  const { sim, planner } = fixture(
    [
      { kind: 'cuboid', size: [0.06, 0.06, 0.06] },
      { kind: 'cuboid', size: [0.04, 0.04, 0.04] },
    ],
    8,
  );
  try {
    const tick = sim.ticks;
    assert.deepEqual(planner.candidates(), []);
    assert.equal(planner.done, true);
    assert.equal(sim.ticks, tick);
  } finally {
    sim.dispose();
  }
});

test('height candidates are bounded and rejected placements do not repeat', () => {
  const { sim, planner } = fixture(
    Array.from({ length: 6 }, () => ({
      kind: 'cuboid' as const,
      size: [0.04, 0.04, 0.04] as [number, number, number],
    })),
  );
  try {
    const candidates = planner.candidates();
    assert.equal(candidates.length, 12);
    assert(candidates.every((goal) => goal.value > 0 && goal.value <= 1));
    planner.rejected(candidates[0]);
    assert(planner.candidates().every((goal) => goal.key !== candidates[0].key));
  } finally {
    sim.dispose();
  }
});
