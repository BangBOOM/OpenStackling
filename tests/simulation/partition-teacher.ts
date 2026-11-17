import { teacherSource } from '../../src/runtime/host/teacher-source';

import { reportPath } from '../runtime/report-path';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolveConfig } from '../../src/runtime/config';
import { cubeObjects } from '../../src/simulation/world/objects';
import { Episode } from '../../src/runtime/episode';

import { registerTask } from '../../src/simulation/tasks/registry';
import { countDefinition } from '../../src/simulation/tasks/partition-count';
import { colorDefinition } from '../../src/simulation/tasks/partition-color';

registerTask(countDefinition);
registerTask(colorDefinition);
const seeds = process.env.SEEDS
  ? process.env.SEEDS.split(',').map(Number)
  : Array.from({ length: 20 }, (_, seed) => seed);
const cases = [
  { name: 'four-pairs', task: { kind: 'partition-count', counts: [2, 2, 2, 2] } },
  { name: 'two-fours', task: { kind: 'partition-count', counts: [4, 4] } },
  { name: 'four-colors', task: { kind: 'partition-color' } },
] as const;
const rows: {
  name: string;
  seed: number;
  outcome: string;
  reason: string;
  seconds: number;
  held: boolean;
  phase: string;
  wallSeconds: number;
}[] = [];
for (const entry of cases) {
  if (process.env.CASE && process.env.CASE !== entry.name) continue;
  for (const seed of seeds) {
    const task =
      entry.task.kind === 'partition-count'
        ? { kind: entry.task.kind, counts: [...entry.task.counts] }
        : { kind: entry.task.kind };
    const config = resolveConfig({
      scene: { objects: cubeObjects(8, 0.05, [2, 2, 2, 2]) },
      task,
      run: { seed, maxSeconds: 480 },
    });
    const episode = new Episode(config, teacherSource);
    const result = await episode.run();
    let held = result.outcome === 'success';
    if (held)
      for (let tick = 0; tick < config.environment.physicsHz * 10; tick++) {
        episode.sim.step();
        episode.score.update();
        if (!episode.score.stable) held = false;
      }
    const row = {
      name: entry.name,
      seed,
      outcome: result.outcome,
      reason: result.reason,
      seconds: result.seconds,
      held,
      phase: episode.phase,
      wallSeconds: result.wallSeconds,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    episode.dispose();
  }
}
await writeFile(
  await reportPath('partition-teacher-20.json', process.env.REPORT),
  JSON.stringify(rows, null, 2) + '\n',
);
for (const name of new Set(rows.map((row) => row.name))) {
  const selected = rows.filter((row) => row.name === name);
  assert(
    selected.filter((row) => row.outcome === 'success' && row.held).length >=
      Math.ceil(selected.length * 0.95),
    `${name} did not reach 95% successful stable episodes`,
  );
}
