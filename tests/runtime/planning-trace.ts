import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WholeBodyTeacher } from '../../src/simulation/control/teachers/whole-body';
import type { Config } from '../../src/runtime/config';
import type { EpisodeResult } from '../../src/runtime/episode-types';
import { reportPath } from './report-path';

const root = path.resolve(process.env.SOURCE_ROOT ?? '.');
const { resolveConfig } = (await import(
  root + '/src/runtime/config.ts'
)) as typeof import('../../src/runtime/config');
const { cubeObjects } = (await import(
  root + '/src/simulation/world/objects.ts'
)) as typeof import('../../src/simulation/world/objects');
const { teacherSource, TeacherSource } = (await import(
  root + '/src/runtime/host/teacher-source.ts'
)) as typeof import('../../src/runtime/host/teacher-source');
const { Episode } = (await import(
  root + '/src/runtime/episode.ts'
)) as typeof import('../../src/runtime/episode');
const { provenance } = (await import(
  root + '/src/runtime/provenance.ts'
)) as typeof import('../../src/runtime/provenance');
const source = await provenance(root);
const report = await reportPath('planning-trace.json', process.env.REPORT);
const cases = [
  [42, 2],
  [2026, 2],
  [0, 2],
  [3, 3],
  [2026, 3],
  [42, 4],
  [2026, 5],
];
type Row = {
  seed: number;
  count: number;
  config: Config;
  wallMs: number;
  digest: string;
  result: Omit<
    EpisodeResult,
    'wallSeconds' | 'physicsMs' | 'observationMs' | 'controlMs' | 'recordMs'
  >;
  decisions: WholeBodyTeacher['decisions'];
  rejected: WholeBodyTeacher['rejected'];
};
const results: Row[] = [];

for (const [seed, count] of cases) {
  const config = resolveConfig({
    scene: { objects: cubeObjects(count) },
    run: { seed, maxSeconds: 240 },
  });
  const hash = createHash('sha256');
  const record = (row: unknown) => {
    hash.update(JSON.stringify(row));
  };
  const episode = new Episode(config, teacherSource, {
    action: record,
    observation: record,
    diagnostic: record,
  });
  const start = performance.now();
  try {
    while (!episode.result) {
      await episode.step();
      record(episode.sim.inspect());
    }
    const { wallSeconds, physicsMs, observationMs, controlMs, recordMs, ...result } =
      episode.result;
    const teacher = (episode.source as InstanceType<typeof TeacherSource>)
      .teacher as WholeBodyTeacher;
    const row = {
      seed,
      count,
      config,
      wallMs: performance.now() - start,
      digest: hash.digest('hex'),
      result,
      decisions: teacher.decisions,
      rejected: teacher.rejected,
    };
    results.push(row);
    await writeFile(report, JSON.stringify({ source, cases, results }, null, 2));
    console.log(
      JSON.stringify({
        seed,
        count,
        outcome: result.outcome,
        ticks: result.ticks,
        digest: row.digest,
      }),
    );
    assert.equal(result.outcome, 'success');
  } finally {
    episode.dispose();
  }
}
if (process.env.BASELINE) {
  const baseline = JSON.parse(await readFile(process.env.BASELINE, 'utf8')) as {
    results: typeof results;
  };
  const behavior = (rows: typeof results) => rows.map(({ wallMs, rejected, ...row }) => row);
  assert.deepEqual(behavior(results), behavior(baseline.results));
}
