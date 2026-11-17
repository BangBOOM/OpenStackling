import { teacherContext } from '../../src/simulation/control/teachers/types';
import { resolveTask } from '../../src/simulation/tasks/registry';
import { createSimulation, fixtureConfig } from './simulation-fixture';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolveConfig } from '../../src/runtime/config';
import { WholeBodyTeacher } from '../../src/simulation/control/teachers/whole-body';
import { BodyHeightPlanner } from '../../src/simulation/control/teachers/body-height';
import { TaskScore } from '../../src/simulation/tasks/registry';
import { cubeObjects, mixedObjects, scaledObjects } from '../../src/simulation/world/objects';

import { reportPath } from '../runtime/report-path';

async function run(seed: number, fixture = false, continuation = false) {
  const objects = continuation
    ? scaledObjects(cubeObjects(6, 0.07), 5 / 9)
    : fixture
      ? cubeObjects(2)
      : scaledObjects(mixedObjects(), 5 / 9);
  if (fixture)
    objects[1].shape = {
      kind: 'cuboid',
      size: [0.18, 0.06, 0.06].map((v) => (v * 5) / 9) as [number, number, number],
    };
  const config = resolveConfig({
    scene: { objects },
    task: { kind: 'max-height' },
    run: { seed, maxSeconds: 240 },
  });
  const sim = createSimulation(config);
  if (fixture) {
    // Positions inside the human-scale workspace, each 0.05 m above its rest height.
    sim.bodies[0].setTranslation({ x: -0.24, y: 0.825, z: -0.16 });
    sim.bodies[1].setTranslation({ x: -0.34, y: 0.817, z: -0.16 });
  }
  const initialHeight =
    Math.max(...sim.bodies.map((_, id) => sim.top(id))) - config.environment.tableTop;
  const score = new TaskScore(sim, resolveTask(fixtureConfig(sim)));
  let placed = 0;
  const planner = new BodyHeightPlanner(sim, teacherContext(config));
  const recordPlacement = planner.placed.bind(planner);
  planner.placed = (goal) => {
    recordPlacement(goal);
    placed++;
  };
  const executor = new WholeBodyTeacher(sim, teacherContext(config), planner);
  let failure = '';
  let largestBarHeight = 0;
  const phases: { phase: string; seconds: number }[] = [];
  let phase = '';
  const controlTicks = config.run.maxSeconds * config.environment.physicsHz;
  for (let tick = 0; tick < controlTicks; tick++) {
    if (tick % (config.environment.physicsHz / config.run.controlHz) === 0 && !failure) {
      const advice = executor.next(1 / config.run.controlHz);
      if (!advice.valid) failure = advice.reason;
      else sim.apply(advice.action);
    }
    sim.step();
    if (!failure) executor.update();
    score.update();
    if (executor.phase !== phase) {
      phase = executor.phase;
      phases.push({ phase, seconds: sim.time });
    }
    largestBarHeight = Math.max(largestBarHeight, sim.extent(1) * 2);
    if (executor.phase === 'failed') failure = executor.reason;
    if (tick % 240 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  sim.apply(sim.targetState());
  score.beginValidation();
  for (let tick = 0; tick < config.task.stableSeconds * config.environment.physicsHz; tick++) {
    sim.step();
    score.update();
  }
  const row = {
    seed,
    fixture,
    continuation,
    initialHeight,
    finalHeight: score.evaluation.heightMeters,
    largestBarHeight,
    finalBarVerticalAlignment: Math.abs(
      2 *
        (sim.bodies[1].rotation().x * sim.bodies[1].rotation().y +
          sim.bodies[1].rotation().z * sim.bodies[1].rotation().w),
    ),
    placed,
    failure,
    phases,
    final: sim.inspect(),
  };
  console.log(
    JSON.stringify({
      seed,
      fixture,
      initialHeight,
      finalHeight: row.finalHeight,
      largestBarHeight,
      placed,
      failure,
    }),
  );
  sim.dispose();
  return row;
}

if (process.env.BENCH_ONLY !== '1') {
  const continuation = await run(42, false, true);
  await writeFile(
    await reportPath('height-continuation.json'),
    JSON.stringify(continuation, null, 2) + '\n',
  );
  assert.equal(continuation.failure, '');
  assert.equal(continuation.placed, 5, 'six suitable cubes must keep stacking beyond two objects');
  assert(
    continuation.finalHeight > (0.41 * 5) / 9,
    'the final six-level structure must remain stable',
  );
  const fixture = await run(42, true);
  await writeFile(
    await reportPath('height-rotation.json'),
    JSON.stringify(fixture, null, 2) + '\n',
  );
  assert(
    fixture.largestBarHeight > (0.17 * 5) / 9,
    'the physical grasp must rotate the horizontal bar upright',
  );
  assert(
    fixture.finalHeight > fixture.initialHeight + (0.05 * 5) / 9,
    'the rotated bar must increase final stable height',
  );
  assert(fixture.placed > 0, 'the shared executor must release and verify a placement');
  assert(
    fixture.finalBarVerticalAlignment > 0.995,
    'the released bar must remain upright at final scoring',
  );
  assert.equal(fixture.failure, '');
}

if (process.env.FIXTURE_ONLY !== '1') {
  const rows = [];
  for (let seed = 0; seed < 20; seed++) {
    rows.push(await run(seed));
    await writeFile(
      await reportPath('height-teacher-20.json'),
      JSON.stringify(
        {
          plannedSeeds: Array.from({ length: 20 }, (_, id) => id),
          status: seed === 19 ? 'complete' : 'running',
          rows,
        },
        null,
        2,
      ) + '\n',
    );
  }
  assert(
    rows.some((row) => row.finalHeight > row.initialHeight + 0.01),
    'the mixed-object teacher must increase stable height on the declared seed plan',
  );
  assert(
    rows.every((row) => !row.failure),
    'all declared mixed-object seeds must finish without teacher failure',
  );
}
