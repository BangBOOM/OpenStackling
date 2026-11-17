import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig } from '../../src/runtime/config';
import { evaluate } from '../../src/runtime/runs/evaluate';
import { collect } from '../../src/runtime/runs/collect';
import { report } from '../../src/runtime/runs/report';
import { inspect } from '../../src/runtime/runs/inspect';
import { replay } from '../../src/runtime/recording/replay';
import { ResultWriter } from '../../src/runtime/recording/result-store';
import { reportPath } from '../runtime/report-path';
const root = path.resolve('.tmp', `evaluation-${Date.now()}`);
await mkdir(root, { recursive: true });
const config = resolveConfig({
  task: { kind: 'max-height' },
  camera: { width: 64, heightPixels: 48 },
  run: { maxSeconds: 0.2 },
});
const generation = { kind: 'random-mixed' as const, version: 2 as const, count: 8 };
const options = {
  out: path.join(root, 'node'),
  seeds: [0, 1, 0],
  workers: 1,
  sceneGeneration: generation,
};
const initial = await evaluate(config, options);
assert.equal(initial.totalCompleted, 3);
assert.equal(initial.frames, 0);
const manifest = JSON.parse(await readFile(path.join(options.out, 'manifest.json'), 'utf8'));
assert.equal(manifest.kind, 'evaluation');
assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.plan[0].resolvedScene.length, 8);
assert.deepEqual(manifest.plan[0].resolvedScene, manifest.plan[2].resolvedScene);
const before = await readFile(path.join(options.out, 'episodes/000000/result.json'), 'utf8');
for (const entry of manifest.plan)
  assert.deepEqual((await readdir(path.join(options.out, 'episodes', entry.id))).sort(), [
    'pending.json',
    'result.json',
  ]);
const firstReport = await report(options.out);
assert.deepEqual(await report(options.out), firstReport);
assert.deepEqual(firstReport.byTask, initial.byTask);
assert.equal(firstReport.byTask['max-height'].heightMeters!.count, 3);
assert.equal((await inspect(options.out)).length, 3);
assert.equal((await inspect(path.join(options.out, 'episodes/000000'))).length, 1);
await assert.rejects(replay(path.join(options.out, 'episodes/000000')), /no action recording/);
assert.equal((await evaluate(config, { ...options, resume: true })).completedThisRun, 0);
assert.equal(await readFile(path.join(options.out, 'episodes/000000/result.json'), 'utf8'), before);
await assert.rejects(evaluate(config, { ...options, seeds: [0, 1, 2], resume: true }), /mismatch/);
await assert.rejects(collect(config, { ...options, resume: true }), /mode\/schema mismatch/);
const visual = path.join(root, 'browser');
const recorded = path.join(root, 'recorded');
await evaluate(config, { ...options, out: visual, visible: true });
await collect(config, { ...options, out: recorded, workers: 2 });
assert.deepEqual((await report(visual)).byTask, firstReport.byTask);
assert.deepEqual((await report(recorded)).byTask, firstReport.byTask);
for (const entry of manifest.plan) {
  const node = JSON.parse(
    await readFile(path.join(options.out, 'episodes', entry.id, 'result.json'), 'utf8'),
  );
  const browser = JSON.parse(
    await readFile(path.join(visual, 'episodes', entry.id, 'result.json'), 'utf8'),
  );
  const full = JSON.parse(
    await readFile(path.join(recorded, 'episodes', entry.id, 'metadata.json'), 'utf8'),
  );
  for (const other of [browser, full])
    for (const key of ['ticks', 'outcome', 'evaluation', 'controlTicks', 'validationTicks'])
      assert.deepEqual(other.result[key], node.result[key]);
  for (const other of [browser, full]) {
    const { state: expected, target: expectedTarget, ...world } = node.result.final;
    const { state: actual, target: actualTarget, ...otherWorld } = other.result.final;
    assert.deepEqual(otherWorld, world);
    assert.equal(actual.length, expected.length);
    const angles = [...actual, ...actualTarget],
      expectedAngles = [...expected, ...expectedTarget];
    // Math.atan2 may round measured angles and their hold targets differently in JavaScriptCore and V8.
    // Keep the underlying rigid-body snapshots exactly equal.
    angles.forEach((value: number, i: number) =>
      assert(
        Math.abs(value - expectedAngles[i]) <=
          Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(expectedAngles[i])),
      ),
    );
  }
}
await assert.rejects(
  evaluate(config, { ...options, out: recorded, resume: true }),
  /mode\/schema mismatch/,
);
await assert.rejects(
  evaluate(config, { ...options, resume: true, visible: true }),
  /browser version mismatch/,
);
// A stopped run retains committed results and restarts the overlapping partial episode.
const interrupted = path.join(root, 'interrupted');
const abort = new AbortController();
const finish = ResultWriter.prototype.finish;
ResultWriter.prototype.finish = async function (...args) {
  const value = await finish.apply(this, args);
  abort.abort();
  return value;
};
try {
  const stopped = await evaluate(config, { ...options, out: interrupted, signal: abort.signal });
  assert(stopped.totalCompleted >= 1 && stopped.totalCompleted < 3);
} finally {
  ResultWriter.prototype.finish = finish;
}
const committed = await readFile(path.join(interrupted, 'episodes/000000/result.json'), 'utf8');
assert.equal(
  (await evaluate(config, { ...options, out: interrupted, resume: true })).totalCompleted,
  3,
);
assert.equal(
  await readFile(path.join(interrupted, 'episodes/000000/result.json'), 'utf8'),
  committed,
);
assert.deepEqual((await report(interrupted)).byTask, firstReport.byTask);
const partials = await readdir(path.join(interrupted, 'interrupted')).catch(() => []);
// Files committed before a manifest update are recovered without rerunning them.
const manifestPath = path.join(options.out, 'manifest.json');
const saved = await readFile(manifestPath, 'utf8');
for (const checksums of [undefined, { ...manifest.checksums, '000002': undefined }]) {
  await writeFile(manifestPath, JSON.stringify({ ...manifest, checksums }));
  await assert.rejects(report(options.out), /checksum/);
  await assert.rejects(inspect(options.out), /checksum/);
  await assert.rejects(evaluate(config, { ...options, resume: true }), /checksum/);
}
const unindexed = JSON.parse(saved);
delete unindexed.completed['000002'];
delete unindexed.checksums['000002'];
await writeFile(manifestPath, JSON.stringify(unindexed));
assert.equal((await evaluate(config, { ...options, resume: true })).completedThisRun, 0);
const corrupted = JSON.parse(before);
corrupted.result.evaluation.heightMeters += 0.01;
await writeFile(path.join(options.out, 'episodes/000000/result.json'), JSON.stringify(corrupted));
await assert.rejects(report(options.out), /checksum/);
await assert.rejects(evaluate(config, { ...options, resume: true }), /checksum/);
await writeFile(path.join(options.out, 'episodes/000000/result.json'), before);
// Task failures are committed and counted in the completion-rate denominator.
const failures = path.join(root, 'failures');
await evaluate(resolveConfig({ run: { maxSeconds: 0.2 } }), {
  out: failures,
  seeds: [42, 2026],
  workers: 1,
});
const failureReport = await report(failures);
assert.equal(failureReport.byTask.tower.failures, 2);
assert.equal(failureReport.byTask.tower.successRate, 0);
assert.equal(
  (
    await evaluate(resolveConfig({ run: { maxSeconds: 0.2 } }), {
      out: failures,
      seeds: [42, 2026],
      workers: 1,
      resume: true,
    })
  ).completedThisRun,
  0,
);
await writeFile(
  await reportPath('evaluation.json'),
  JSON.stringify(
    {
      root,
      passed: [
        'node/browser/full-recording parity',
        'immutable plans and duplicate seeds',
        'result-only artifacts',
        'offline reports and inspection',
        'resume and mode rejection',
        'interrupted and unindexed commit recovery',
        'corruption rejection',
        'failed-task retention',
      ],
      partials,
    },
    null,
    2,
  ),
);
console.log(`evaluation: all scenarios passed (${root})`);
