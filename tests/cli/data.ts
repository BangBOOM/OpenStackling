import { reportPath } from '../runtime/report-path';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { collect } from '../../src/runtime/runs/collect';
import { inspect } from '../../src/runtime/runs/inspect';
import { replay } from '../../src/runtime/recording/replay';
import { resolveConfig } from '../../src/runtime/config';
import { EpisodeWriter, type EpisodeMetadata } from '../../src/runtime/recording/storage';
import { provenance } from '../../src/runtime/provenance';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
const root = path.resolve(`.tmp/data-tests-${Date.now()}`);
await mkdir(root, { recursive: true });
const config = resolveConfig({
    run: { maxSeconds: 2, observationHz: 15, controlHz: 8 },
    camera: { depth: true },
  }),
  seeds = [0, 1];
const single = path.join(root, 'single'),
  dual = path.join(root, 'dual');
await collect(config, { out: single, seeds, workers: 1 });
await collect(config, { out: dual, seeds, workers: 2 });
for (const dataset of [single, dual]) {
  const results = await inspect(dataset);
  assert.equal(results.length, 2);
  assert(results.every((r) => r.observations === 30 && r.actions === 16));
}
for (const id of ['000000', '000001']) {
  const a: EpisodeMetadata = JSON.parse(
      await readFile(path.join(single, 'episodes', id, 'metadata.json'), 'utf8'),
    ),
    b: EpisodeMetadata = JSON.parse(
      await readFile(path.join(dual, 'episodes', id, 'metadata.json'), 'utf8'),
    );
  assert.deepEqual(a.result.final, b.result.final);
  // Hardware video encoders are not byte-deterministic; npz is.
  assert.deepEqual(Object.keys(a.files).sort(), ['data.npz', 'video.mp4']);
  assert.equal(a.files['data.npz'], b.files['data.npz']);
  await replay(path.join(single, 'episodes', id));
}
const before = (await stat(path.join(single, 'episodes/000000/metadata.json'))).mtimeMs;
const resumed = await collect(config, { out: single, seeds, workers: 2, resume: true });
assert.equal(resumed.completedThisRun, 0);
assert.equal((await stat(path.join(single, 'episodes/000000/metadata.json'))).mtimeMs, before);
await assert.rejects(
  collect(resolveConfig({ run: { maxSeconds: 3 } }), {
    out: single,
    seeds,
    workers: 1,
    resume: true,
  }),
  /mismatch/,
);
// Corrupted data is detected by content hashes.
const npz = path.join(single, 'episodes/000000/data.npz'),
  bytes = await readFile(npz);
await writeFile(npz, 'broken');
await assert.rejects(inspect(single), /Checksum/);
await writeFile(npz, bytes);
// Slow sink introduces backpressure, without losing timestamps.
const host = new BrowserHost(),
  source = await provenance();
await host.start();
try {
  const writer = new EpisodeWriter(
    root,
    'slow',
    resolveConfig({ run: { maxSeconds: 1, observationHz: 30 } }),
    source,
  );
  await writer.begin();
  const append = writer.append.bind(writer);
  writer.append = async (rows) => {
    await new Promise((r) => setTimeout(r, 30));
    await append(rows);
  };
  const page = await host.newPage(),
    output = await host.run(page, writer.config, writer);
  await writer.finish(output.result, output.metrics);
  assert.equal((await inspect(writer.destination))[0].observations, 30);
  // A disk error prevents atomic episode completion.
  const broken = new EpisodeWriter(
    root,
    'disk-error',
    resolveConfig({ run: { maxSeconds: 1 } }),
    source,
  );
  await broken.begin();
  broken.append = async () => {
    throw new Error('injected disk failure');
  };
  await assert.rejects(host.run(page, broken.config, broken), /injected disk failure/);
  await assert.rejects(stat(broken.destination));
  // A renderer crash leaves only an incomplete episode.
  const crash = new EpisodeWriter(root, 'crash', resolveConfig(), source);
  await crash.begin();
  const crashedPage = await host.newPage();
  const pending = assert.rejects(host.run(crashedPage, crash.config, crash));
  await crashedPage.close();
  await pending;
  await assert.rejects(stat(crash.destination));
} finally {
  await host.close();
}
// A failed export stops the run instead of silently skipping later commits.
const finishError = path.join(root, 'finish-error'),
  finish = EpisodeWriter.prototype.finish;
EpisodeWriter.prototype.finish = async () => {
  throw new Error('injected finish failure');
};
try {
  await assert.rejects(
    collect(resolveConfig({ run: { maxSeconds: 1 } }), {
      out: finishError,
      seeds: [3, 4, 5, 6],
      workers: 1,
    }),
    /injected finish failure/,
  );
} finally {
  EpisodeWriter.prototype.finish = finish;
}
const uncommitted = await readdir(path.join(finishError, 'episodes'));
assert(
  uncommitted.every((name) => name.startsWith('.')),
  'a failed export committed an episode',
);
// The failed commit stops the run; only the overlapping in-flight episode may exist.
assert(uncommitted.length <= 2, `the collector kept assigning seeds after a failed export`);
// Graceful interruption does not commit a partial episode; resume restarts it.
const abortedPath = path.join(root, 'aborted'),
  abort = new AbortController();
const job = collect(config, { out: abortedPath, seeds: [2], workers: 1, signal: abort.signal });
setTimeout(() => abort.abort(), 350);
await job;
const complete = await collect(config, { out: abortedPath, seeds: [2], workers: 1, resume: true });
assert.equal(complete.totalCompleted, 1);
await inspect(abortedPath);
// Full episode exercises success scoring and recorded-action reproduction.
const success = path.join(root, 'success');
await collect(resolveConfig(), { out: success, seeds: [42], workers: 1 });
assert.equal((await inspect(success))[0].outcome, 'success');
await replay(path.join(success, 'episodes/000000'));
await writeFile(
  await reportPath('data.json', process.env.REPORT),
  JSON.stringify(
    {
      root,
      passed: [
        'single/dual identical',
        'independent clocks',
        'checksum corruption',
        'resume',
        'slow sink',
        'disk error',
        'finish error',
        'renderer crash',
        'interrupt/resume',
        'success replay',
      ],
    },
    null,
    2,
  ),
);
console.log(`data: all scenarios passed (${root})`);
