import { teacherSource } from '../../src/runtime/host/teacher-source';

import { reportPath } from '../runtime/report-path';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';
import { scaledObjects, sizedObjects } from '../../src/simulation/world/objects';
import { Episode } from '../../src/runtime/episode';

const seeds = (process.env.SEEDS ?? Array.from({ length: 20 }, (_, i) => i).join(','))
  .split(',')
  .map(Number);
const orders = ['any', 'size-ascending', 'size-descending'] as const;
const results: {
  order: string;
  seed: number;
  outcome: string;
  held: boolean;
  reason: string;
  seconds: number;
}[] = [];

for (const order of orders) {
  if (process.env.ORDER && order !== process.env.ORDER) continue;
  for (const seed of seeds) {
    const config = resolveConfig({
      scene: { objects: scaledObjects(sizedObjects([0.06, 0.075, 0.09]), 5 / 9) },
      task: { kind: 'tower', order },
      run: { seed, maxSeconds: 240 },
    });
    const episode = new Episode(config, teacherSource);
    try {
      const result = await episode.run();
      let held = result.outcome === 'success';
      if (held) {
        for (let tick = 0; tick < config.environment.physicsHz * 10; tick++) {
          episode.sim.step();
          episode.score.update();
          if (!episode.score.stable) held = false;
        }
      }
      const row = {
        order,
        seed,
        outcome: result.outcome,
        held,
        reason: result.reason,
        seconds: result.seconds,
      };
      results.push(row);
      console.log(JSON.stringify(row));
    } finally {
      episode.dispose();
    }
  }
}

await writeFile(
  await reportPath('sized-teacher-20.json', process.env.REPORT),
  JSON.stringify(results, null, 2) + '\n',
);

for (const order of orders) {
  const rows = results.filter((row) => row.order === order);
  if (!rows.length) continue;
  const successes = rows.filter((row) => row.outcome === 'success' && row.held).length;
  console.log(JSON.stringify({ order, successes, episodes: rows.length }));
  assert(
    successes >= Math.ceil(rows.length * 0.95),
    `${order}: ${successes}/${rows.length} stable successes`,
  );
}
