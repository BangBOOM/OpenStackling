import { teacherSource } from '../../src/runtime/host/teacher-source';
import * as THREE from 'three';
import { humanoidLink } from '../../src/runtime/browser/render/humanoid';
import { createSimulation } from './simulation-fixture';
import { cubeObjects } from '../../src/simulation/world/objects';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveConfig } from '../../src/runtime/config';

import { samplePositions } from '../../src/simulation/scene';
import { kinematics } from '../../src/simulation/control/kinematics';
import { bodyKin } from '../../src/simulation/control/body-planning';
import { forward } from '../../src/simulation/world/geometry';
import { validateEnvironment } from '../../src/simulation/world/config';
import { Episode } from '../../src/runtime/episode';

import { stackIsStable } from '../../src/simulation/tasks/stability';
import { hash, provenance } from '../../src/runtime/provenance';
import { appearanceIdentity } from '../../src/runtime/appearance';
import { THEME_IDS } from '../../src/runtime/theme-catalog';

test('forearm and wrist remain visually connected through axial rotation', () => {
  const config = resolveConfig().environment.robot;
  const material = new THREE.MeshBasicMaterial();
  const mesh = (geometry: THREE.BufferGeometry) => new THREE.Mesh(geometry, material);
  const arm = humanoidLink(config, 2, mesh);
  const wrist = humanoidLink(config, 3, mesh);
  wrist.position.x = config.links[2];
  arm.add(wrist);
  try {
    for (const roll of [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
      wrist.rotation.x = roll;
      arm.updateMatrixWorld(true);
      for (const offset of [-0.01, -0.006, -0.002, 0, 0.002]) {
        for (let i = 0; i < 12; i++) {
          // Avoid exact triangle edges when ray-testing the closed surfaces.
          const angle = 0.137 + (i * Math.PI) / 6;
          const radial = new THREE.Vector3(0, Math.cos(angle), Math.sin(angle));
          const origin = radial.clone().multiplyScalar(0.1);
          origin.x = config.links[2] + offset;
          const hits = new THREE.Raycaster(origin, radial.negate(), 0, 0.1).intersectObject(
            arm,
            true,
          );
          assert(hits.length > 0, `Open joint at roll=${roll}, offset=${offset}, view=${angle}`);
        }
      }
    }
  } finally {
    arm.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    material.dispose();
  }
});
test('themes have source identities and never enter the physical configuration', async () => {
  for (const theme of THEME_IDS) {
    const config = resolveConfig({ appearance: { theme } });
    assert.equal(
      appearanceIdentity(theme).contentHash,
      hash(await readFile(`src/runtime/browser/render/themes/${theme}.ts`)),
    );
    const sim = createSimulation(config);
    assert.equal('appearance' in sim.config, false);
    sim.dispose();
  }
  assert.throws(() => resolveConfig({ appearance: { theme: 'missing' as any } }), /Unknown theme/);
  assert.throws(
    () => resolveConfig({ appearance: { theme: 'laboratory' as any } }),
    /Unknown theme/,
  );
});
test('theme selection preserves physical trajectories, scoring and episode configuration', async () => {
  for (const seed of [42, 2026]) {
    const traces = [];
    for (const theme of THEME_IDS) {
      const episode = new Episode(
        resolveConfig({ appearance: { theme }, run: { seed } }),
        teacherSource,
      );
      const action = episode.sim.targetState();
      action[0] += 0.08;
      episode.sim.apply(action);
      const trace = [];
      for (let tick = 0; tick < 240; tick++) {
        episode.sim.step();
        episode.score.update();
        if (tick % 24 === 0) trace.push(episode.sim.inspect());
      }
      traces.push({ trace, success: episode.score.success, stable: episode.score.stableSeconds });
      episode.dispose();
    }
    for (const trace of traces.slice(1)) assert.deepEqual(traces[0], trace);
  }
  const episode = new Episode(resolveConfig(), teacherSource);
  assert(episode.setAppearance('studio'));
  await episode.step();
  assert.equal(episode.setAppearance('island'), false);
  assert.equal(episode.config.appearance.theme, 'studio');
  episode.finish('stopped', 'test');
  assert.equal(episode.setAppearance('island'), false);
  episode.dispose();
});
test('configuration layers override before validation and retain explicit time limits', () => {
  const file = { scene: { objects: cubeObjects(7) }, run: { observationHz: 7 } };
  const override = { scene: { objects: cubeObjects(2) }, run: { observationHz: 10 } };
  const c = resolveConfig(file, override);
  assert.equal(c.scene.objects.length, 2);
  assert.equal(c.run.observationHz, 10);
  assert.equal(c.run.maxSeconds, 120);
  assert.equal(resolveConfig({}, { scene: { objects: cubeObjects(5) } }).run.maxSeconds, 240);
  assert.equal(
    resolveConfig({ run: { maxSeconds: 75 } }, { scene: { objects: cubeObjects(5) } }).run
      .maxSeconds,
    75,
  );
  assert.throws(() => resolveConfig(override, file));
});
test('provenance includes build configuration and browser entry points', async () => {
  const source = await provenance();
  for (const file of ['tsconfig.json', 'index.html', 'worker.html'])
    assert.equal(source.files[file], hash(await readFile(file)));
});
test('configuration rejects incompatible rates, invalid geometry and impossible layouts', () => {
  assert.throws(() => resolveConfig({ run: { observationHz: 7 } }));
  assert.throws(() => resolveConfig({ camera: { width: 0 } }));
  assert.throws(() => resolveConfig({ scene: { objects: cubeObjects(7) } }));
  assert.throws(() => resolveConfig({ run: { seed: -1 } }));
  const c = resolveConfig({ scene: { region: [0, 0.001, 0, 0.001] } });
  assert.throws(() => samplePositions(c), /maxAttempts/);
});
test('sampling is reproducible and leaves gripper clearance', () => {
  const c = resolveConfig({ scene: { objects: cubeObjects(5) } });
  assert.deepEqual(samplePositions(c), samplePositions(c));
  const points = samplePositions(c);
  for (const [i, p] of points.entries())
    for (const q of points.slice(i + 1))
      assert(Math.abs(p.x - q.x) >= 0.088 || Math.abs(p.z - q.z) >= 0.06);
  assert.notDeepEqual(
    samplePositions(c),
    samplePositions(resolveConfig({ run: { seed: 43 }, scene: { objects: cubeObjects(5) } })),
  );
});
test('blocks start supported and do not visibly drop when physics starts', () => {
  for (const blockSize of [0.035, 0.05, 0.075]) {
    const config = resolveConfig({ scene: { objects: cubeObjects(2, blockSize) } }),
      sim = createSimulation(config);
    try {
      const initial = sim.bodies.map((body) => ({ ...body.translation() }));
      for (const p of initial)
        assert(Math.abs(p.y - blockSize / 2 - config.environment.tableTop) < 1e-6);
      for (let tick = 0; tick < config.environment.physicsHz / 2; tick++) {
        sim.step();
        sim.bodies.forEach((body, i) => {
          const p = body.translation(),
            start = initial[i];
          assert(
            Math.hypot(p.x - start.x, p.y - start.y, p.z - start.z) < 0.0002,
            `startup displacement for ${blockSize} m block at tick ${tick}`,
          );
        });
      }
    } finally {
      sim.dispose();
    }
  }
});
test('world is DOM-free, accepts only legal 16D actions, measures physical state', () => {
  const c = resolveConfig(),
    s = createSimulation(c);
  try {
    assert.equal(s.metadata.impulseJoints, 18);
    const measured = s.bodies[0].translation();
    measured.y -= 1;
    assert.notEqual(s.bodies[0].translation().y, measured.y);
    const tool = s.arms[0].pose();
    tool.x += 1;
    assert.notEqual(s.arms[0].pose().x, tool.x);
    const home = s.arms[0].state();
    home.forEach((v, i) =>
      assert(
        Math.abs(v - (i === 6 ? c.environment.robot.home.gap : c.environment.robot.homeJoints[i])) <
          1e-5,
      ),
    );
    assert.throws(() => s.apply(Array(16).fill(Infinity) as any));
    assert.throws(() => s.apply(Array(16).fill(3) as any));
    const target = s.targetState();
    target[2] += 0.1;
    s.apply(target);
    assert(Math.abs(s.arms[0].state()[0] - target[2]) > 0.09);
    for (let i = 0; i < 240; i++) s.step();
    assert(Math.abs(s.arms[0].state()[0] - target[2]) < 0.02);
    s.reset();
    assert.deepEqual(
      s.bodies.map((b) => ({ ...b.translation() })),
      samplePositions(c).map((p) => ({
        x: Math.fround(p.x),
        y: Math.fround(p.y),
        z: Math.fround(p.z),
      })),
    );
  } finally {
    s.dispose();
  }
});
test('both arms and waist kinematics cover the declared workspace', () => {
  const c = resolveConfig(),
    k = kinematics(c.environment),
    r = c.environment.robot,
    s = createSimulation(c);
  try {
    const f = forward(r, r.homeJoints).position,
      p = s.arms[0].pose();
    assert(Math.hypot(f.x - p.x, f.y - p.y, f.z - p.z) < 1e-5);
    for (const x of [
      c.scene.region[0],
      (c.scene.region[0] + c.scene.region[1]) / 2,
      c.scene.region[1],
    ])
      for (const z of [
        c.scene.region[2],
        (c.scene.region[2] + c.scene.region[3]) / 2,
        c.scene.region[3],
      ]) {
        const waypoints = [
          { x, y: c.environment.tableTop + 0.2, z },
          { x, y: c.environment.tableTop + 0.006, z },
          { x, y: c.environment.tableTop + 0.2, z },
        ];
        const reachable = [0, 1].some((arm) =>
          [0, -0.35, 0.35].some((yaw) =>
            [0, 0.2, 0.4].some((pitch) =>
              bodyKin(s, arm, [yaw, pitch]).clearPath(waypoints, r.homeJoints),
            ),
          ),
        );
        assert(reachable, `path ${x},${z}`);
      }
  } finally {
    s.dispose();
  }
});
test('sampling clock, action clock and terminal interval remain independent', async () => {
  const c = resolveConfig({ run: { maxSeconds: 1, observationHz: 15, controlHz: 8 } }),
    obs: number[] = [],
    actions: number[] = [];
  const e = new Episode(
    c,
    (s) => ({
      name: 'hold',
      reset() {},
      end() {},
      next() {
        return { action: s.targetState(), valid: true, reason: '', phase: 'hold' };
      },
    }),
    {
      observation(r) {
        obs.push(r.tick);
      },
      action(r) {
        actions.push(r.tick);
      },
      diagnostic() {},
    },
  );
  try {
    const result = await e.run();
    assert.equal(result.outcome, 'timeout');
    assert.deepEqual(
      obs,
      Array.from({ length: 15 }, (_, i) => i * 8),
    );
    assert.deepEqual(
      actions,
      Array.from({ length: 8 }, (_, i) => i * 15),
    );
  } finally {
    e.dispose();
  }
});
test('negative controls fail truthfully', async () => {
  const e = new Episode(resolveConfig(), teacherSource);
  e.sim.bodies.forEach((b) => b.collider(0).setFriction(0));
  e.sim.arms.flatMap((arm) => arm.fingers).forEach((b) => b.collider(0).setFriction(0));
  try {
    const r = await e.run();
    assert.notEqual(r.outcome, 'success');
  } finally {
    e.dispose();
  }
  const dropped = new Episode(resolveConfig({ run: { maxSeconds: 1 } }), teacherSource);
  dropped.sim.bodies[0].setTranslation({ x: 2, y: 0.4, z: 0 });
  try {
    await dropped.run();
    assert.equal(dropped.result?.outcome, 'timeout');
  } finally {
    dropped.dispose();
  }
  const c = resolveConfig(),
    s = createSimulation(c);
  try {
    assert.equal(stackIsStable(s, [0, 1]), false);
    assert.equal(
      kinematics(c.environment).inverse({ x: 10, y: 10, z: 10 }, c.environment.robot.homeJoints),
      null,
    );
  } finally {
    s.dispose();
  }
});
test('alternate physics and control clocks complete the same fixed task', async () => {
  const e = new Episode(
    resolveConfig({ environment: { physicsHz: 240 }, run: { controlHz: 8, observationHz: 12 } }),
    teacherSource,
  );
  try {
    const r = await e.run();
    assert.equal(r.outcome, 'success', r.reason);
    assert(e.score.stableSeconds + 1e-9 >= e.config.task.stableSeconds);
  } finally {
    e.dispose();
  }
});

test('whole-body manipulation separates adjacent blocks with independent stable scoring', async () => {
  const e = new Episode(resolveConfig({ scene: { clearance: false } }), teacherSource);
  e.sim.bodies[0].setTranslation({ x: -0.0455, y: 0.85, z: 0 });
  e.sim.bodies[1].setTranslation({ x: 0.0455, y: 0.85, z: 0 });
  try {
    const result = await e.run();
    assert.equal(result.outcome, 'success', result.reason);
    assert(e.score.stable);
    assert.equal(e.sim.metadata.impulseJoints, 18);
    for (let tick = 0; tick < 1200; tick++) {
      e.sim.step();
      e.score.update();
      assert(e.score.stable);
    }
  } finally {
    e.dispose();
  }
});

test('cancellation while observing does not execute a later action', async () => {
  let release!: () => void,
    entered!: () => void,
    calls = 0;
  const observed = new Promise<void>((r) => {
    entered = r;
  });
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  const e = new Episode(
    resolveConfig(),
    (s) => ({
      name: 'hold',
      reset() {},
      end() {},
      next() {
        calls++;
        return { action: s.targetState(), valid: true, reason: '', phase: 'hold' };
      },
    }),
    {
      async observation() {
        entered();
        await waiting;
      },
      action() {},
      diagnostic() {},
    },
  );
  try {
    const step = e.step();
    await observed;
    e.finish('stopped', 'test');
    release();
    await step;
    assert.equal(calls, 0);
    assert.equal(e.sim.ticks, 0);
  } finally {
    e.dispose();
  }
});

test('human-scale preflight rejects a reachable pose whose palm folds into the forearm', async () => {
  const { robotObjectClearance } = await import('../../src/simulation/control/clearance');
  const config = resolveConfig();
  const sim = createSimulation(config);
  try {
    const kin = kinematics(config.environment);
    const joints = kin.inverse({ x: -0.4, y: 1.18, z: -0.35 }, config.environment.robot.homeJoints);
    assert(joints);
    assert(kin.staticClearance(joints), 'table and fixed body alone do not detect this collision');
    assert.equal(robotObjectClearance(sim, joints, 0, config.environment.robot.gap[1]), false);
  } finally {
    sim.dispose();
  }
});

test('both grippers rest at the near table edge and settling preserves the forward pose', async () => {
  const { Vector3 } = await import('three');
  const config = resolveConfig();
  const e = new Episode(config, teacherSource);
  try {
    const idle = e.sim.arms[1];
    const edge = -config.environment.tableDepth / 2;
    for (const tip of [idle.pose(), e.sim.arms[0].pose()]) {
      assert(
        Math.abs(tip.z - edge - 0.02) < 0.002,
        'fingertips must rest just inside the near edge',
      );
      assert(tip.y > config.environment.tableTop + 0.075, 'fingers must clear the tabletop');
    }
    const parked = new Vector3(1, 0, 0).applyQuaternion(idle.rotation());
    assert(parked.z > Math.cos(Math.PI / 12) && parked.y < 0);
    for (
      let tick = 0;
      tick < Math.ceil(config.environment.physicsHz * config.teacher.settleSeconds) - 1;
      tick++
    )
      await e.step();
    const actual = new Vector3(1, 0, 0).applyQuaternion(e.sim.arms[0].rotation());
    assert(
      actual.z > Math.cos(Math.PI / 12) && actual.y < 0,
      'settling must preserve the slightly downward ready pose',
    );
    assert(Math.abs(e.sim.arms[0].pose().y - config.environment.robot.home.y) < 0.002);
    assert(Math.abs(e.sim.arms[0].pose().z - edge - 0.02) < 0.002);
  } finally {
    e.dispose();
  }
});

test('rectangular workbench keeps width and depth distinct in validation and physics', () => {
  const config = resolveConfig({ scene: { objects: cubeObjects(2) } });
  assert.doesNotThrow(() => resolveConfig({ scene: { region: [0.36, 0.44, -0.1, 0.1] } }));
  assert.throws(
    () => resolveConfig({ scene: { region: [-0.1, 0.1, 0.36, 0.44] } }),
    /sampling region/,
  );
  const sim = createSimulation(config);
  try {
    sim.bodies[0].setTranslation({ x: 0.42, y: config.environment.tableTop + 0.025, z: 0 });
    sim.bodies[1].setTranslation({ x: 0, y: config.environment.tableTop + 0.025, z: 0.42 });
    for (let tick = 0; tick < config.environment.physicsHz; tick++) sim.step();
    assert(Math.abs(sim.bodies[0].translation().y - config.environment.tableTop - 0.025) < 0.001);
    assert(
      sim.bodies[1].translation().y < 0.2,
      'the shorter depth edge must not act like a square tabletop',
    );
  } finally {
    sim.dispose();
  }
});

test('sled feet support contacts and the environment requires explicit support geometry', async () => {
  const { tableFrame } = await import('../../src/simulation/world/geometry');
  const config = resolveConfig({ scene: { objects: cubeObjects(2) } });
  const environment = structuredClone(config.environment);
  assert.equal(tableFrame({ ...environment, tableSupport: 'legs' }).length, 4);
  delete (environment as any).tableSupport;
  assert.throws(() => validateEnvironment(environment), /table support/);
  assert.throws(
    () => resolveConfig({ environment: { tableSupport: 'unknown' as any } }),
    /table support/,
  );
  const sim = createSimulation(config);
  try {
    const x = config.environment.tableSize / 2 - 0.045;
    sim.bodies[0].setTranslation({ x, y: 0.15, z: 0 });
    sim.bodies[1].setTranslation({ x: 0, y: 0.15, z: 0.15 });
    for (let tick = 0; tick < config.environment.physicsHz * 2; tick++) sim.step();
    assert(
      Math.abs(sim.bodies[0].translation().y - 0.073) < 0.002,
      'the visible foot must have a physical collider',
    );
    assert(
      Math.abs(sim.bodies[1].translation().y - 0.025) < 0.002,
      'the center beneath the table stays open',
    );
  } finally {
    sim.dispose();
  }
});
