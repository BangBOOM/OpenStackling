import { teacherSource } from '../../src/runtime/host/teacher-source';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { reportPath } from '../runtime/report-path';
import { resolveConfig } from '../../src/runtime/config';
import { cubeObjects } from '../../src/simulation/world/objects';
import { Episode } from '../../src/runtime/episode';
import { TeacherSource } from '../../src/runtime/host/teacher-source';
import { WholeBodyTeacher } from '../../src/simulation/control/teachers/whole-body';
import { provenance } from '../../src/runtime/provenance';
import { MeasuredMotion, MOTION_METRICS_VERSION } from '../../src/runtime/runs/teacher-evaluation';

const source = await provenance();
const seeds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 42];
const cases = [
  ...[2, 3, 4].flatMap((count) => seeds.map((seed) => ({ count, seed, stress: false }))),
  ...[5, 6].flatMap((count) => [42, 2026].map((seed) => ({ count, seed, stress: true }))),
];
const results = [];
const reportFile = await reportPath('whole-body-validation.json', process.env.REPORT);
for (const selected of cases) {
  const config = resolveConfig({
    scene: { objects: cubeObjects(selected.count) },
    run: { seed: selected.seed },
  });
  const episode = new Episode(config, teacherSource),
    teacher = (episode.source as TeacherSource).teacher as WholeBodyTeacher;
  const joints = episode.sim.metadata.impulseJoints;
  const motion = new MeasuredMotion();
  motion.sample(episode.sim);
  const carried = new Set<string>();
  while (!episode.result) {
    await episode.step();
    motion.sample(episode.sim, episode.stage === 'active' && episode.phase !== 'success');
    assert.equal(
      episode.sim.metadata.impulseJoints,
      joints,
      'Grasping must not add attachment joints',
    );
    if (episode.phase === 'carry') {
      const decision = teacher.decisions.at(-1)!;
      if (
        episode.sim.arms[decision.arm]
          .contact(episode.sim.bodies[decision.object])
          .every(Boolean) &&
        episode.sim.bottom(decision.object) > config.environment.tableTop + 0.015
      )
        carried.add(`${decision.arm}:${decision.grasp}`);
    }
  }
  let held = true;
  if (episode.result.outcome === 'success')
    for (let i = 0; i < 1200; i++) {
      episode.sim.step();
      episode.score.update();
      if (!episode.score.stable) held = false;
    }
  const row = {
    ...selected,
    config,
    result: episode.result,
    held,
    carried: [...carried],
    decisions: teacher.decisions,
    motion: motion.snapshot(),
  };
  results.push(row);
  await writeFile(
    reportFile,
    JSON.stringify(
      { status: 'running', source, cases, results, motionMetricsVersion: MOTION_METRICS_VERSION },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      ...selected,
      outcome: row.result.outcome,
      reason: row.result.reason,
      seconds: row.result.seconds,
      held,
      carried: row.carried,
    }),
  );
  episode.dispose();
}
const negative = new Episode(resolveConfig({ run: { seed: 42 } }), teacherSource);
for (const body of [...negative.sim.bodies, ...negative.sim.arms.flatMap((a) => a.fingers)])
  body.collider(0).setFriction(0);
const negativeResult = await negative.run();
negative.dispose();
const report = {
  status: 'complete',
  date: new Date().toISOString(),
  source,
  motionMetricsVersion: MOTION_METRICS_VERSION,
  cases,
  results,
  zeroFriction: negativeResult,
};
await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
assert.notEqual(negativeResult.outcome, 'success', 'Grasping must require physical friction');
const regular = results.filter((r) => !r.stress);
assert(
  regular.filter((r) => r.result.outcome === 'success' && r.held).length >=
    Math.ceil(regular.length * 0.95),
  'Whole-body regression success rate fell below 95%',
);
assert(
  results.some((r) => r.carried.some((v) => v.startsWith('0:'))) &&
    results.some((r) => r.carried.some((v) => v.startsWith('1:'))),
  'Both arms must physically carry objects',
);

assert(
  results.some((r) => r.carried.includes('0:oblique') || r.carried.includes('1:oblique')),
  'Oblique grasp coverage',
);
