import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolveConfig } from '../../src/runtime/config';
import { collect } from '../../src/runtime/runs/collect';
import { inspect } from '../../src/runtime/runs/inspect';
import { replay } from '../../src/runtime/recording/replay';
import { readNpz } from '../../src/runtime/recording/npz';
import { reportPath } from '../runtime/report-path';

await mkdir('.tmp', { recursive: true });
const root = `${await mkdtemp('.tmp/whole-body-data-')}/dataset`;
const config = resolveConfig({ camera: { mount: 'head', depth: true } });
const collected = await collect(config, { out: root, seeds: [42], workers: 1 });
const inspected = await inspect(root);
const episode = `${root}/episodes/000000`;
const replayed = await replay(episode);
const metadata = JSON.parse(await readFile(`${episode}/metadata.json`, 'utf8'));
const arrays = readNpz(await readFile(`${episode}/data.npz`));
const shapes = Object.fromEntries(Object.entries(arrays).map(([key, value]) => [key, value.shape]));
assert.equal(metadata.kind, 'dataset');
assert.equal(metadata.schemaVersion, 10);
assert.equal(inspected[0].outcome, 'success');
assert.equal(replayed.sourceMatches, true);
assert.equal(shapes['obs.state'][1], 16);
assert.equal(shapes['act.executed'][1], 16);
assert.deepEqual(shapes['obs.camera_to_world'], [metadata.counts.observations, 4, 4]);
assert.deepEqual(shapes['obs.depth'], [metadata.counts.observations, 240, 320]);
assert.deepEqual(shapes['diag.tcp'], [metadata.counts.diagnostics, 2, 8]);
assert.deepEqual(shapes['diag.actuators'], [metadata.counts.diagnostics, 14, 9]);
assert.deepEqual(shapes['diag.fingers'], [metadata.counts.diagnostics, 2, 2, 6]);
assert.deepEqual(shapes['diag.contacts'], [
  metadata.counts.diagnostics,
  2,
  config.scene.objects.length,
  2,
  5,
]);
assert.deepEqual(shapes['diag.blocks'], [
  metadata.counts.diagnostics,
  config.scene.objects.length,
  13,
]);
assert(replayed.maxDiagnostic < 1e-5);
const poses = arrays['obs.camera_to_world'].data as Float64Array;
const cameraMoved = Array.from(poses).some((v, i) => Math.abs(v - poses[i % 16]) > 0.001);
// Sensor extrinsics must replay exactly, whether the selected task needs waist motion or not.
assert(replayed.maxCamera < 1e-7);
assert.equal(replayed.observations, metadata.counts.observations);
await writeFile(
  await reportPath('whole-body-data.json', process.env.REPORT),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      root,
      metadata,
      shapes,
      cameraMoved,
      collected,
      inspected,
      replayed,
    },
    null,
    2,
  ) + '\n',
);
console.log('Whole-body RGB-D collection, schema inspection and exact action replay passed');
