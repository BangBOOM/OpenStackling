import { teacherSource } from '../../src/runtime/host/teacher-source';
import { createSimulation } from './simulation-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { resolveConfig } from '../../src/runtime/config';
import {
  cubeObjects,
  mixedObjects,
  randomMixedObjects,
  scaledObjects,
  halfExtent,
} from '../../src/simulation/world/objects';
import { Simulation } from '../../src/simulation/world/simulation';
import { Episode } from '../../src/runtime/episode';
import { TeacherSource } from '../../src/runtime/host/teacher-source';
import { WholeBodyTeacher } from '../../src/simulation/control/teachers/whole-body';
import { teacherContext } from '../../src/simulation/control/teachers/types';
import { DOWN } from '../../src/simulation/world/geometry';
import { bodyKin } from '../../src/simulation/control/body-planning';

test('primitive geometry, dimensions and rotations drive the real physical scene', () => {
  const objects = mixedObjects();
  const sim = createSimulation(
    resolveConfig({
      scene: { objects, region: [-0.32, 0.32, 0.04, 0.25] },
      task: { kind: 'max-height' },
    }),
  );
  assert.equal(sim.objects.length, 6);
  assert.equal(sim.metadata.impulseJoints, 18);
  for (let i = 0; i < 240; i++) sim.step();
  sim.bodies.forEach((body, i) =>
    assert(
      Math.abs(
        body.translation().y -
          sim.config.environment.tableTop -
          halfExtent(objects[i].shape, body.rotation()),
      ) < 0.001,
    ),
  );
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  assert(Math.abs(halfExtent(objects[1].shape, rotation) - 0.09) < 1e-8);
  sim.dispose();
});
test('orientation targets rotate the physical robot through absolute joint actions', () => {
  const sim = createSimulation(resolveConfig());
  const desired = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.25).multiply(DOWN);
  // The forward-facing home adds a quarter-turn before the requested downward yaw.
  for (let tick = 0; tick < 720; tick++) {
    if (tick % 12 === 0) {
      const target = sim.targetState();
      const q = bodyKin(sim, 0, target.slice(0, 2)).inverse(
        { x: -0.25, y: 1.15, z: -0.2 },
        target.slice(2, 8),
        desired,
      );
      assert(q);
      target.splice(2, 7, ...q, sim.config.environment.robot.gap[1]);
      sim.apply(target);
    }
    sim.step();
  }
  const r = sim.arms[0].rotation();
  assert(new Quaternion(r.x, r.y, r.z, r.w).angleTo(desired) < 0.04);
  sim.dispose();
});
test('height cutoff stops source callbacks and keeps recording aligned system holds', async () => {
  const c = resolveConfig({
    scene: { objects: cubeObjects(2) },
    task: { kind: 'max-height' },
    run: { maxSeconds: 1 },
  });
  let observe = 0,
    act = 0,
    after = 0;
  const rows: any[] = [];
  const e = new Episode(
    c,
    (sim) => ({
      name: 'teacher',
      reset() {},
      end() {},
      observe() {
        observe++;
        return Promise.resolve();
      },
      afterStep() {
        after++;
      },
      next() {
        act++;
        return { action: sim.targetState(), valid: true, reason: '', phase: 'idle' };
      },
    }),
    {
      observation(row) {
        rows.push(['obs', row]);
      },
      action(row) {
        rows.push(['act', row]);
      },
      diagnostic() {},
    },
  );
  const result = await e.run();
  assert.equal(result.outcome, 'completed');
  assert.equal(result.controlTicks, 120);
  assert.equal(c.task.stableSeconds, 1);
  assert.equal(result.validationTicks, 120);
  assert.equal(observe, 10);
  assert.equal(act, e.config.run.controlHz);
  assert.equal(after, 120);
  const actions = rows.filter((r) => r[0] === 'act').map((r) => r[1]);
  assert.equal(actions.length, e.config.run.controlHz * 2);
  assert.equal(rows.filter((r) => r[0] === 'obs').length, 20);
  assert(
    actions
      .slice(e.config.run.controlHz)
      .every((r) => r.controller === 'evaluation-hold' && !r.label_valid),
  );
  assert(result.evaluation.heightMeters > 0.049 && result.evaluation.heightMeters < 0.051);
  e.dispose();
});
test('nonintegral validation duration rounds up and cuboid tuples are validated at the boundary', async () => {
  const objects = cubeObjects(2);
  (objects[0].shape as { kind: 'cuboid'; size: number[] }).size.push(0.09);
  assert.throws(() => resolveConfig({ scene: { objects } }), /three dimensions/);
  const e = new Episode(
    resolveConfig({ task: { kind: 'max-height', stableSeconds: 0.101 }, run: { maxSeconds: 0.1 } }),
    (sim) => ({
      name: 'hold',
      reset() {},
      end() {},
      next() {
        return { action: sim.targetState(), valid: true, phase: 'idle', reason: '' };
      },
    }),
  );
  const result = await e.run();
  assert.equal(result.validationTicks, 13);
  assert(result.evaluation.heightMeters > 0.049);
  e.dispose();
});
test('pausing while recording gates action submission', async () => {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  const e = new Episode(
    resolveConfig(),
    (sim) => ({
      name: 'hold',
      reset() {},
      end() {},
      next() {
        const action = sim.targetState();
        action[0] += 0.1;
        return { action, valid: true, phase: 'idle', reason: '' };
      },
    }),
    {
      observation() {},
      async action() {
        entered();
        await waiting;
      },
      diagnostic() {},
    },
  );
  const target = e.sim.targetState();
  const step = e.step();
  await started;
  e.pause();
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(e.sim.targetState(), target);
  assert.equal(e.sim.ticks, 0);
  e.resume();
  await step;
  assert.equal(e.sim.ticks, 1);
  e.dispose();
});
test(
  'a released cube may settle with a stable offset on its intended support',
  { timeout: 300000 },
  async () => {
    const e = new Episode(
      resolveConfig({
        scene: { objects: cubeObjects(8, 0.05, [2, 2, 2, 2]) },
        task: { kind: 'partition-color' },
        run: { seed: 3, maxSeconds: 480 },
      }),
      teacherSource,
    );
    try {
      const result = await e.run();
      assert.equal(result.outcome, 'success', result.reason);
      for (let tick = 0; tick < 1200; tick++) {
        e.sim.step();
        e.score.update();
        assert(e.score.stable);
      }
    } finally {
      e.dispose();
    }
  },
);
test(
  'stable released objects keep their intended upright axis without requiring an exact quaternion',
  { timeout: 120000 },
  async () => {
    for (const [seed, objects, count] of [
      [12, scaledObjects(mixedObjects(), 5 / 9), 1],
      [2026, scaledObjects(randomMixedObjects(12, 2026), 5 / 9), 3],
    ] as const) {
      const e = new Episode(
        resolveConfig({
          scene: { objects },
          task: { kind: 'max-height' },
          run: { seed, maxSeconds: 240 },
        }),
        teacherSource,
      );
      try {
        for (let tick = 0; tick < 15000 && !e.result; tick++) await e.step();
        assert.equal(e.result, null, `seed ${seed}: ${e.result?.reason}`);
        assert((e.source as any).teacher.completedPlacements >= count);
        assert(e.score.evaluation.heightMeters > (0.18 * 5) / 9);
      } finally {
        e.dispose();
      }
    }
  },
);
test(
  'a rotated bar can settle off center on its measured cylinder support',
  { timeout: 120000 },
  async () => {
    const e = new Episode(
      resolveConfig({
        scene: { objects: scaledObjects(mixedObjects(), 5 / 9) },
        task: { kind: 'max-height' },
        run: { seed: 3, maxSeconds: 60 },
      }),
      (sim, config) => {
        const source = new TeacherSource(sim, config);
        source.reset = () => {
          let placed = false;
          // Fix the goal to isolate physical release verification from height-search preferences.
          source.teacher = new WholeBodyTeacher(sim, teacherContext(config), {
            get done() {
              return placed;
            },
            candidates() {
              if (placed) return [];
              const object = 1,
                support = 4,
                rotation = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
              return [
                {
                  key: 'bar-on-cylinder',
                  value: 1,
                  object,
                  support,
                  rotation,
                  position: {
                    ...sim.bodies[support].translation(),
                    y: sim.top(support) + halfExtent(sim.objects[object].shape, rotation),
                  },
                },
              ];
            },
            placed() {
              placed = true;
            },
            rejected() {
              assert.fail('The release fixture must be reachable');
            },
          });
        };
        return source;
      },
    );
    try {
      const result = await e.run();
      assert.equal(result.outcome, 'completed', result.reason);
      assert.equal((e.source as TeacherSource).teacher.completedPlacements, 1);
      assert.equal(e.sim.metadata.impulseJoints, 18);
      assert(e.score.evaluation.heightMeters > (0.31 * 5) / 9);
    } finally {
      e.dispose();
    }
  },
);

test('physical world accepts resolved mixed objects without task, teacher, camera or seed ownership', async () => {
  const { worldConfig } = await import('../../src/simulation/scene');
  const { mixedObjects } = await import('../../src/simulation/world/objects');
  const config = resolveConfig();
  const input = worldConfig({
    environment: config.environment,
    scene: { ...config.scene, objects: mixedObjects() },
    run: { seed: 42 },
  });
  const sim = new Simulation(input);
  try {
    assert.deepEqual(Object.keys(sim.config).sort(), ['environment', 'scene']);
    assert.equal(sim.objects.length, 6);
    const initial = sim.inspect();
    for (let tick = 0; tick < 120; tick++) sim.step();
    sim.reset();
    assert.deepEqual(sim.inspect(), initial);
    for (let tick = 0; tick < 30; tick++) sim.step();
    assert(sim.bottom(0) >= config.environment.tableTop - 0.004);
    assert.deepEqual(sim.bodies[0].translation(), sim.frame.bodies[sim.bodies[0].id].position);
  } finally {
    sim.dispose();
  }
  const { readFile, readdir } = await import('node:fs/promises');
  for (const file of await readdir('src/simulation/world')) {
    if (!file.endsWith('.ts')) continue;
    assert.doesNotMatch(
      await readFile(`src/simulation/world/${file}`, 'utf8'),
      /from ['"]\.\.\/(?:tasks|control|runner|ui|render|config)(?:\/|['"])/,
    );
  }
  assert.throws(() => resolveConfig({ scene: { objects: mixedObjects() } }), /require cubes/);
});
