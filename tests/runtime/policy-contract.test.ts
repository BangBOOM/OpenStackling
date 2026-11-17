import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from '../../protocol/fixtures.json';
import {
  configForProfile,
  assertCompatible,
  taskCase,
  digest,
  type Profile,
  validateAction,
  actualConfig,
  makeProfile,
  profileConfig,
  validate,
  validateProfile,
} from '../../src/runtime/policy/contract';
test('shared schema, semantic constraints and JCS fixtures', async () => {
  const resolved = configForProfile(fixtures.profile as Profile);
  assert.deepEqual(resolved.environment, fixtures.profile.config.environment);
  assert.equal(resolved.environment.tableDepth, 0.7);
  assert.deepEqual(resolved.camera, fixtures.profile.config.camera);
  assert.equal(resolved.camera.mount, 'external');
  assert.equal(await digest(fixtures.canonical), fixtures.canonicalHash);
  assert.equal(await digest(fixtures.actual), fixtures.actualHash);
  for (const sample of fixtures.cases) {
    const p = structuredClone(fixtures.profile) as any;
    const keys = sample.path.split('.');
    let target = p;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)!] = sample.value;
    assert.throws(() => configForProfile(p), sample.path);
  }
  const p = structuredClone(fixtures.profile);
  p.config.camera.fov = Infinity;
  assert.throws(() => configForProfile(p as Profile));
  assert.throws(() => validateAction(Array(16).fill(NaN) as any, profileConfig(resolved)));
});

import { resolveConfig } from '../../src/runtime/config';
import { cubeObjects, randomMixedObjects } from '../../src/simulation/world/objects';
test('policy preserves episode task and appearance independently of training metadata', async () => {
  const training = resolveConfig(),
    shifted = resolveConfig({ appearance: { theme: 'studio' } });
  const profile = makeProfile(training, '0'.repeat(64));
  const original = structuredClone(profile);
  assert.deepEqual(profileConfig(training), profileConfig(shifted));
  assert.notEqual(await digest(actualConfig(training)), await digest(actualConfig(shifted)));
  assert.deepEqual(profile, original);
  const current = resolveConfig(shifted, {
    run: { seed: 2026, cameraSeed: 123, maxSeconds: 6 },
    task: { kind: 'max-height', language: 'zh' },
  });
  const bound = configForProfile(profile, current);
  assert.deepEqual(bound, current);
  assertCompatible(profile, current);
  assert.notDeepEqual(taskCase(current), profile.trainingTasks[0]);
  const wrongCamera = resolveConfig(current, { camera: { width: 64 } });
  assert.throws(() => assertCompatible(profile, wrongCamera), /Runtime configuration/);
  assert(!Object.hasOwn(profile, 'schemaVersion'));
  assert.throws(() =>
    validate('appearance', { ...actualConfig(shifted).appearance, contentHash: 'bad' }),
  );
});
test('training coverage does not restrict episode inventory or require a default scene', () => {
  const profile = makeProfile(resolveConfig(), '0'.repeat(64));
  profile.trainingTasks[0].prompt.text = 'Historical training instruction, preserved verbatim.';
  profile.trainingTasks[0].prompt.templateVersion = 7;
  validateProfile(profile);
  profile.trainingTasks = [];
  const mixed = resolveConfig({
    scene: { objects: randomMixedObjects(8, 2026) },
    task: { kind: 'max-height', language: 'zh' },
    run: { maxSeconds: 17, cameraSeed: 999 },
    appearance: { theme: 'studio' },
  });
  assertCompatible(profile, mixed);
  assert.deepEqual(configForProfile(profile, mixed), mixed);
  profile.config.environment.tableSize = 0.4;
  validateProfile(profile);
  const small = resolveConfig({
    environment: { tableSize: 0.4 },
    scene: { region: [-0.1, 0.1, -0.1, 0.1], objects: cubeObjects(1, 0.06) },
  });
  assert.deepEqual(configForProfile(profile, small), small);
});

import { environmentFingerprint } from '../../src/runtime/provenance';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('runtime fingerprint excludes task catalog and scene defaults while retaining physical code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stackling-runtime-'));
  try {
    for (const dir of ['src/runtime', 'src/simulation', 'configs', 'physics']) {
      await mkdir(path.dirname(path.join(root, dir)), { recursive: true });
      await cp(dir, path.join(root, dir), { recursive: true });
    }
    for (const name of ['three', 'fflate']) {
      const file = path.join(root, 'node_modules', name, 'package.json');
      await mkdir(path.dirname(file), { recursive: true });
      await cp(path.join('node_modules', name, 'package.json'), file);
    }
    for (const name of ['Cargo.toml', 'Cargo.lock']) await cp(name, path.join(root, name));
    await mkdir(path.join(root, '.tmp/physics'), { recursive: true });
    await cp('.tmp/physics/build.json', path.join(root, '.tmp/physics/build.json'));
    await cp('src/simulation/validation.ts', path.join(root, 'src/simulation/validation.ts'));
    const original = await environmentFingerprint(root);
    const defaultsFile = path.join(root, 'configs/default.json');
    const defaults = JSON.parse(await readFile(defaultsFile, 'utf8'));
    defaults.scene.objects = [];
    defaults.task.kind = 'future-task';
    defaults.run.seed = 2026;
    await writeFile(defaultsFile, JSON.stringify(defaults));
    await mkdir(path.join(root, 'src/simulation/tasks'), { recursive: true });
    await writeFile(
      path.join(root, 'src/simulation/tasks/new-task.ts'),
      'export const task = "new";',
    );
    assert.equal(await environmentFingerprint(root), original);
    const robot = path.join(root, 'physics/src/actuator.rs');
    await writeFile(
      robot,
      (await readFile(robot, 'utf8')) + '\n// Changed physical implementation.\n',
    );
    assert.notEqual(await environmentFingerprint(root), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
import { Episode } from '../../src/runtime/episode';
test('pause retains an awaited action; resume does not repeat it; stop discards it', async () => {
  for (const stop of [false, true]) {
    let deliver!: () => void;
    let calls = 0;
    const episode = new Episode(resolveConfig(), (sim) => ({
      name: 'test',
      reset() {},
      end() {},
      async next() {
        calls++;
        await new Promise<void>((r) => {
          deliver = r;
        });
        return { action: sim.targetState(), valid: true, reason: '', phase: 'test' };
      },
    }));
    const step = episode.step();
    while (!deliver) await new Promise((r) => setTimeout(r, 0));
    episode.pause();
    deliver();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(episode.sim.ticks, 0);
    assert.equal(calls, 1);
    if (stop) episode.finish('stopped', 'test');
    else episode.resume();
    await step;
    assert.equal(episode.sim.ticks, stop ? 0 : 1);
    assert.equal(calls, 1);
    episode.dispose();
  }
});
