import { teacherSource } from '../../src/runtime/host/teacher-source';
import { cubeObjects } from '../../src/simulation/world/objects';
import { reportPath } from '../runtime/report-path';
import { writeFile } from 'node:fs/promises';
import { resolveConfig } from '../../src/runtime/config';
import { Episode } from '../../src/runtime/episode';

const blocks = Number(process.env.BLOCKS ?? 2);
const seeds = (
    process.env.SEEDS ??
    (process.env.ZERO_FRICTION
      ? '42'
      : blocks === 5
        ? '42,2026'
        : Array.from({ length: 100 }, (_, i) => i).join(','))
  )
    .split(',')
    .map(Number),
  results = [];
for (const seed of seeds) {
  const c = resolveConfig({
    scene: { objects: cubeObjects(blocks) },
    run: { seed, ...(process.env.HZ ? { controlHz: Number(process.env.HZ) } : {}) },
  });
  const e = new Episode(c, teacherSource);
  if (process.env.ZERO_FRICTION) {
    e.sim.bodies.forEach((b) => b.collider(0).setFriction(0));
    e.sim.arms.flatMap((arm) => arm.fingers).forEach((b) => b.collider(0).setFriction(0));
  }
  const result = await e.run();
  let held = true;
  if (result.outcome === 'success')
    for (let i = 0; i < c.environment.physicsHz * 10; i++) {
      e.sim.step();
      e.score.update();
      if (!e.score.stable) held = false;
    }
  const row = { seed, blocks, ...result, held };
  results.push(row);
  console.log(
    JSON.stringify({
      seed,
      blocks,
      outcome: result.outcome,
      reason: result.reason,
      seconds: result.seconds,
      wall: result.wallSeconds,
      held,
      phase: e.phase,
    }),
  );
  e.dispose();
}
await writeFile(
  await reportPath(`teacher-${seeds.length === 100 ? 100 : blocks}.json`, process.env.REPORT),
  JSON.stringify(results, null, 2),
);
const successes = results.filter((r) => r.outcome === 'success' && r.held).length;
if (process.env.ZERO_FRICTION ? successes > 0 : successes < Math.ceil(seeds.length * 0.95))
  process.exitCode = 1;
