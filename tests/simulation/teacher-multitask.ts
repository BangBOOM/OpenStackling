import { teacherSource } from '../../src/runtime/host/teacher-source';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig, type Config, type DeepPartial } from '../../src/runtime/config';
import { cubeObjects } from '../../src/simulation/world/objects';
import type { Vec3 } from '../../src/simulation/world/types';
import { TASK_PRESETS, presetPatch, type TaskPreset } from '../../src/runtime/presets';
import { Episode } from '../../src/runtime/episode';
import { type EpisodeResult } from '../../src/runtime/episode-types';
import { TeacherSource } from '../../src/runtime/host/teacher-source';
import { resolveEpisode } from '../../src/runtime/plan';
import { WholeBodyTeacher } from '../../src/simulation/control/teachers/whole-body';
import {
  MeasuredMotion,
  MOTION_METRICS_VERSION,
  type MotionMetrics,
} from '../../src/runtime/runs/teacher-evaluation';
import { provenance } from '../../src/runtime/provenance';
import { reportPath } from '../runtime/report-path';

type Case = {
  preset: TaskPreset;
  variant: 'standard' | 'height-fixture';
  seed: number;
  config: Config;
};
type Row = Case & {
  resolvedScene: ReturnType<typeof resolveEpisode>['resolvedScene'];
  result: EpisodeResult | null;
  initialHeight: number;
  held: boolean | null;
  carried: string[];
  decisions: WholeBodyTeacher['decisions'];
  motion: MotionMetrics;
  phases: { phase: string; seconds: number; positions: Vec3[] }[];
  infrastructureError?: string;
};

const seeds = (process.env.SEEDS ?? '42,2026,0').split(',').map(Number);
assert(
  seeds.length > 0 &&
    seeds.every((seed) => Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff),
);
const presets = process.env.PRESETS
  ? (process.env.PRESETS.split(',') as TaskPreset[])
  : [...TASK_PRESETS];
assert(presets.length > 0 && presets.every((preset) => TASK_PRESETS.includes(preset)));
const partitionCounts = (process.env.PARTITION_COUNTS ?? '2,2').split(',').map(Number);
assert(
  partitionCounts.length > 0 &&
    partitionCounts.every((count) => Number.isInteger(count) && count > 0),
);
const partitionObjects = partitionCounts.reduce((sum, count) => sum + count, 0);
const cases: Case[] = [];
for (const preset of presets) {
  const variants =
    preset === 'max-height' ? (['height-fixture', 'standard'] as const) : (['standard'] as const);
  for (const variant of variants)
    for (const seed of seeds) {
      let patch: DeepPartial<Config> = {};
      if (preset === 'stack-all') patch = { scene: { objects: cubeObjects(3) } };
      if (preset === 'partition-count')
        patch = {
          scene: { objects: cubeObjects(partitionObjects) },
          task: { kind: 'partition-count', counts: partitionCounts },
        };
      if (preset === 'partition-color')
        patch = { scene: { objects: cubeObjects(partitionObjects, 0.05, partitionCounts) } };
      if (variant === 'height-fixture') {
        const objects = cubeObjects(3, 0.07);
        objects[1].shape = { kind: 'cylinder', radius: 0.022, height: 0.07 };
        objects[2].shape = { kind: 'cuboid', size: [0.09, 0.035, 0.035] };
        patch = { scene: { objects } };
      }
      cases.push({
        preset,
        variant,
        seed,
        config: resolveConfig(presetPatch(preset, seed), patch, { run: { seed } }),
      });
    }
}

const source = await provenance();
const rows: Row[] = [];
const report = await reportPath('teacher-multitask.json', process.env.REPORT);
async function save() {
  const metadata = {
    date: new Date().toISOString(),
    source,
    motionMetricsVersion: MOTION_METRICS_VERSION,
    cases,
    status: rows.length === cases.length ? 'complete' : 'running',
    rows,
  };
  await writeFile(report, JSON.stringify(metadata, null, 2) + '\n');
  for (const preset of presets) {
    const selected = cases.filter((entry) => entry.preset === preset),
      results = rows.filter((entry) => entry.preset === preset);
    await writeFile(
      path.join(path.dirname(report), `${path.basename(report, '.json')}-${preset}.json`),
      JSON.stringify(
        {
          ...metadata,
          cases: selected,
          rows: results,
          status: results.length === selected.length ? 'complete' : 'running',
        },
        null,
        2,
      ) + '\n',
    );
  }
}
await save();
for (const entry of cases) {
  const resolved = resolveEpisode(entry.config),
    episode = new Episode(entry.config, teacherSource, undefined, resolved);
  const teacher = (episode.source as TeacherSource).teacher as WholeBodyTeacher;
  const joints = episode.sim.metadata.impulseJoints,
    carried = new Set<string>();
  const motion = new MeasuredMotion();
  motion.sample(episode.sim);
  const row: Row = {
    ...entry,
    resolvedScene: resolved.resolvedScene,
    result: null,
    initialHeight:
      Math.max(...episode.sim.bodies.map((_, id) => episode.sim.top(id))) -
      entry.config.environment.tableTop,
    held: null,
    carried: [],
    decisions: [],
    motion: motion.snapshot(),
    phases: [],
  };
  try {
    assert.equal(joints, 18, 'The humanoid has two waist joints and two independent physical arms');
    while (!episode.result) {
      await episode.step();
      motion.sample(episode.sim, episode.stage === 'active' && episode.phase !== 'success');
      if (row.phases.at(-1)?.phase !== episode.phase)
        row.phases.push({
          phase: episode.phase,
          seconds: episode.sim.time,
          positions: episode.sim.bodies.map((body) => ({ ...body.translation() })),
        });
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
          episode.sim.bottom(decision.object) > entry.config.environment.tableTop + 0.015
        )
          carried.add(`${decision.arm}:${decision.grasp}`);
      }
    }
    row.result = episode.result;
    if (episode.score.task.mode === 'completion') {
      row.held = episode.result.outcome === 'success';
      if (row.held)
        for (let i = 0; i < entry.config.environment.physicsHz * 10; i++) {
          episode.sim.step();
          episode.score.update();
          if (!episode.score.stable) row.held = false;
        }
    }
  } catch (error) {
    row.infrastructureError =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    row.result = episode.result;
  } finally {
    row.carried = [...carried];
    row.motion = motion.snapshot();
    row.decisions = structuredClone(teacher.decisions);
    episode.dispose();
  }
  rows.push(row);
  await save();
  console.log(
    JSON.stringify({
      preset: entry.preset,
      variant: entry.variant,
      seed: entry.seed,
      objects: entry.config.scene.objects.length,
      outcome: row.result?.outcome,
      reason: row.result?.reason,
      seconds: row.result?.seconds,
      held: row.held,
      initialHeight: row.initialHeight,
      finalHeight: row.result?.evaluation.heightMeters,
      carried: row.carried,
      infrastructureError: row.infrastructureError,
    }),
  );
}

assert(
  rows.every((row) => !row.infrastructureError),
  'Infrastructure failures are retained in the report',
);
for (const row of rows) {
  const result = row.result!;
  if (row.preset !== 'max-height') {
    assert.equal(result.outcome, 'success', `${row.preset} seed ${row.seed}: ${result.reason}`);
    assert.equal(row.held, true, `${row.preset} seed ${row.seed}: tower did not retain stability`);
  } else {
    assert.equal(result.outcome, 'completed', `${row.variant} seed ${row.seed}: ${result.reason}`);
    assert.equal(result.controlTicks, row.config.environment.physicsHz * row.config.run.maxSeconds);
    assert.equal(
      result.validationTicks,
      Math.ceil(row.config.environment.physicsHz * row.config.task.stableSeconds),
    );
    if (row.variant === 'height-fixture') {
      assert(
        result.evaluation.heightMeters > row.initialHeight + 0.01,
        `Height fixture seed ${row.seed} must improve final stable height`,
      );
      assert(row.carried.length > 0, 'Height fixture requires a real lifted friction grasp');
    }
  }
}
const generated = rows.filter((row) => row.preset === 'max-height' && row.variant === 'standard');
if (generated.length)
  assert(
    generated.some((row) => row.result!.evaluation.heightMeters > row.initialHeight + 0.01),
    'Generated height cases must show actual stable-height improvement',
  );
