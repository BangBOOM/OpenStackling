import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig } from '../../src/runtime/config';
import { collect } from '../../src/runtime/runs/collect';
import { inspect } from '../../src/runtime/runs/inspect';
import { replay } from '../../src/runtime/recording/replay';
import { readNpz } from '../../src/runtime/recording/npz';
import { EpisodeWriter } from '../../src/runtime/recording/storage';
import { randomMixedObjects, scaledObjects } from '../../src/simulation/world/objects';
const root = path.resolve('.tmp', `multitask-${Date.now()}`);
await mkdir(root, { recursive: true });
const config = resolveConfig({ camera: { width: 64, heightPixels: 48 }, run: { maxSeconds: 0.2 } });
const cases = [
  config,
  resolveConfig(config, { task: { kind: 'partition-count', counts: [1, 1] } }),
  resolveConfig(config, {
    task: { kind: 'max-height' },
    camera: { position: 'N' },
    appearance: { theme: 'studio' },
  }),
];
const manifests: any[] = [];
for (const workers of [1, 2]) {
  const out = path.join(root, `workers-${workers}`);
  const summary = await collect(config, { out, seeds: [42, 42], workers, cases });
  assert.equal(summary.totalCompleted, 6);
  assert.equal(summary.byCase.length, 3);
  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  manifests.push(manifest);
  assert.equal(manifest.plan.length, 6);
  assert(
    manifest.plan
      .slice(4)
      .every((p: any) => p.config.camera.position === 'N' && p.appearance.id === 'studio'),
  );
  assert.equal(new Set(manifest.plan.map((p: any) => p.id)).size, 6);
  assert.deepEqual(
    manifest.plan.map((p: any) => p.config.run.seed),
    [42, 42, 42, 42, 42, 42],
  );
  await inspect(out);
  const episode = path.join(out, 'episodes', '000004');
  const metadata = JSON.parse(await readFile(path.join(episode, 'metadata.json'), 'utf8'));
  assert.equal(metadata.result.outcome, 'completed');
  assert.equal(metadata.result.validationTicks, 120);
  const npz = readNpz(await readFile(path.join(episode, 'data.npz')));
  assert.deepEqual(npz['act.teacher_action'].shape, npz['act.executed'].shape);
  const controllers = npz['act.controller'].data as Uint8Array,
    masks = npz['act.label_valid'].data as Uint8Array;
  for (let i = 0; i < controllers.length; i++)
    assert.equal(Boolean(masks[i]), metadata.format.controllers[controllers[i]] === 'teacher');
  await replay(episode);
  const before = await readFile(path.join(episode, 'metadata.json'), 'utf8');
  await collect(config, { out, seeds: [42, 42], workers, cases, resume: true });
  assert.equal(await readFile(path.join(episode, 'metadata.json'), 'utf8'), before);
  await assert.rejects(
    collect(config, { out, seeds: [42, 43], workers, cases, resume: true }),
    /mismatch/,
  );
}
assert.deepEqual(manifests[0].plan, manifests[1].plan);
assert.deepEqual(manifests[0].completed, manifests[1].completed);
// Inventory generation belongs to the immutable plan, before worker assignment.
const height = resolveConfig(config, { task: { kind: 'max-height' } });
const heightPlans: any[] = [];
for (const workers of [1, 2]) {
  const out = path.join(root, `random-height-${workers}`);
  const options = {
    out,
    seeds: [0, 1, 0],
    workers,
    sceneGeneration: { kind: 'random-mixed' as const, version: 2 as const, count: 8 },
  };
  const summary = await collect(height, options);
  assert.equal(summary.totalCompleted, 3);
  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  heightPlans.push(manifest.plan);
  assert.deepEqual(manifest.sceneGeneration, { kind: 'random-mixed', version: 2, count: 8 });
  for (const entry of manifest.plan)
    assert.deepEqual(
      entry.config.scene.objects,
      scaledObjects(randomMixedObjects(8, entry.config.run.seed), 5 / 9),
    );
  assert.deepEqual(manifest.plan[0].config.scene.objects, manifest.plan[2].config.scene.objects);
  const shapeCounts = (entry: any) =>
    entry.config.scene.objects.reduce((counts: Record<string, number>, object: any) => {
      counts[object.shape.kind] = (counts[object.shape.kind] ?? 0) + 1;
      return counts;
    }, {});
  assert.notDeepEqual(shapeCounts(manifest.plan[0]), shapeCounts(manifest.plan[1]));
  const rows = await inspect(out);
  assert(rows.every((row) => row.outcome === 'completed'));
  const episode = path.join(out, 'episodes/000000');
  const before = await readFile(path.join(episode, 'metadata.json'), 'utf8');
  const repeated = JSON.parse(
    await readFile(path.join(out, 'episodes/000002/metadata.json'), 'utf8'),
  );
  assert.deepEqual(JSON.parse(before).resolvedScene, repeated.resolvedScene);
  await replay(episode);
  assert.equal((await collect(height, { ...options, resume: true })).completedThisRun, 0);
  assert.equal(await readFile(path.join(episode, 'metadata.json'), 'utf8'), before);
  await assert.rejects(
    collect(height, {
      ...options,
      sceneGeneration: { kind: 'random-mixed' as const, version: 2 as const, count: 7 },
      resume: true,
    }),
    /mismatch/,
  );
  await assert.rejects(
    collect(height, { ...options, sceneGeneration: undefined, resume: true }),
    /mismatch/,
  );
}
assert.deepEqual(heightPlans[0], heightPlans[1]);
// Stop after the first committed export, retaining any overlapping partial episode.
const interruptedOut = path.join(root, 'random-height-interrupted');
const interruptedOptions = {
  out: interruptedOut,
  seeds: [0, 1, 0],
  workers: 1,
  sceneGeneration: { kind: 'random-mixed' as const, version: 2 as const, count: 8 },
};
const abort = new AbortController();
const finish = EpisodeWriter.prototype.finish;
EpisodeWriter.prototype.finish = async function (...args) {
  const result = await finish.apply(this, args);
  abort.abort();
  return result;
};
try {
  const stopped = await collect(height, { ...interruptedOptions, signal: abort.signal });
  assert(stopped.totalCompleted >= 1 && stopped.totalCompleted < 3);
} finally {
  EpisodeWriter.prototype.finish = finish;
}
const committed = path.join(interruptedOut, 'episodes/000000/metadata.json');
const committedBefore = await readFile(committed, 'utf8');
const resumed = await collect(height, { ...interruptedOptions, workers: 2, resume: true });
assert.equal(resumed.totalCompleted, 3);
assert.equal(await readFile(committed, 'utf8'), committedBefore);
const resumedManifest = JSON.parse(
  await readFile(path.join(interruptedOut, 'manifest.json'), 'utf8'),
);
assert.deepEqual(resumedManifest.plan, heightPlans[0]);
await inspect(interruptedOut);
console.log(
  'multitask: duplicate seeds, immutable cases, per-seed random height inventories, single/dual workers, masks, inspect, replay and interrupted resume passed',
);
