import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';
import { resolveTask } from '../../src/simulation/tasks/registry';
import { DEFAULT_TEACHER_POLICY } from '../../src/simulation/control/teacher-policy';
import {
  MeasuredMotion,
  compareTeacherQuality,
  motionCost,
  noTaskRegression,
  summarizeTeacherTrials,
  type CaseQuality,
  type TeacherTrial,
} from '../../src/runtime/runs/teacher-evaluation';
import {
  teacherCandidates,
  validateTeacherSplits,
  selectTeacherCandidate,
} from '../../src/app/cli/tune-teacher';

const quality = (name: string, reliability: number, motion: number, height = 0): CaseQuality => ({
  name,
  episodes: 4,
  reliability,
  motion,
  height,
  mode: name === 'height' ? 'deadline' : 'completion',
});

test('tuning cannot exchange task reliability or stable height for smooth inactivity', () => {
  const baseline = [quality('tower', 1, 4), quality('height', 1, 4, 0.5)];
  assert.equal(
    noTaskRegression([quality('tower', 0.75, 0), quality('height', 1, 0, 0.8)], baseline),
    false,
  );
  assert.equal(
    noTaskRegression([quality('tower', 1, 0), quality('height', 1, 0, 0.4)], baseline),
    false,
  );
  const improved = [quality('tower', 1, 3), quality('height', 1, 3, 0.5)];
  assert.equal(noTaskRegression(improved, baseline), true);
  assert(compareTeacherQuality(improved, baseline) < 0);
  assert(
    compareTeacherQuality([quality('height', 1, 100, 0.6)], [quality('height', 1, 0, 0.5)]) < 0,
  );
  const result = selectTeacherCandidate([
    {
      candidate: { id: 'candidate-000', policy: DEFAULT_TEACHER_POLICY },
      split: 'validation',
      quality: baseline,
      episodes: [],
    },
    {
      candidate: { id: 'candidate-001', policy: DEFAULT_TEACHER_POLICY },
      split: 'validation',
      quality: [quality('tower', 0, 0), quality('height', 1, 0, 0.5)],
      episodes: [],
    },
  ]);
  assert.equal(result.candidate.id, 'candidate-000');
});

test('candidate proposals are reproducible and retain an explicit unchanged baseline', () => {
  const a = teacherCandidates(DEFAULT_TEACHER_POLICY, 7, 42);
  assert.deepEqual(a, teacherCandidates(DEFAULT_TEACHER_POLICY, 7, 42));
  assert.notDeepEqual(a, teacherCandidates(DEFAULT_TEACHER_POLICY, 7, 43));
  assert.deepEqual(a[0].policy, DEFAULT_TEACHER_POLICY);
  assert(
    a
      .slice(1)
      .every(
        (candidate) =>
          Object.entries(candidate.policy).filter(
            ([key, value]) =>
              value !== DEFAULT_TEACHER_POLICY[key as keyof typeof DEFAULT_TEACHER_POLICY],
          ).length === 1,
      ),
  );
});

test('optimization, selection and sealed test seeds cannot overlap or be empty', () => {
  validateTeacherSplits({ train: [0, 1], validation: [10], test: [20] });
  assert.throws(
    () => validateTeacherSplits({ train: [0, 0], validation: [10], test: [20] }),
    /duplicate/,
  );
  assert.throws(
    () => validateTeacherSplits({ train: [0], validation: [10], test: [10] }),
    /disjoint/,
  );
  assert.throws(
    () => validateTeacherSplits({ train: [], validation: [10], test: [20] }),
    /contain seeds/,
  );
  assert.throws(
    () => validateTeacherSplits({ train: [-1], validation: [10], test: [20] }),
    /uint32/,
  );
});

test('motion metrics distinguish deliberate waist reversals from contact jitter', () => {
  const broad = new MeasuredMotion(),
    jitter = new MeasuredMotion(),
    idle = new MeasuredMotion();
  for (let i = 0; i <= 40; i++) {
    for (const [collector, amplitude] of [
      [broad, 0.2],
      [jitter, 0.001],
    ] as const) {
      const state = Array(16).fill(0);
      state[0] = amplitude * Math.sin((i * Math.PI) / 10);
      collector.observe({ time: i / 10, state, tcp: [{ x: 0, y: 0, z: 0 }], working: true });
    }
    idle.observe({
      time: i / 10,
      state: Array(16).fill(0),
      tcp: [{ x: 0, y: 0, z: 0 }],
      working: false,
    });
  }
  assert(broad.snapshot().waistYawReversals >= 3);
  assert.equal(broad.snapshot().waistPitchReversals, 0);
  assert.equal(broad.snapshot().armJointTravel, 0);
  assert.equal(jitter.snapshot().waistReversals, 0);
  assert.equal(idle.snapshot().idleSeconds, 0, 'Deadline waiting after useful work is intentional');
  assert(
    broad.snapshot().jointAccelerationVariation > jitter.snapshot().jointAccelerationVariation,
  );
  assert(motionCost(idle.snapshot()) > 0, 'Elapsed time is not free');
});

test('failed height trials contribute zero final height and remain in the denominator', () => {
  const config = resolveConfig({ task: { kind: 'max-height' } });
  const task = resolveTask(config);
  const motion = new MeasuredMotion().snapshot();
  const trial: TeacherTrial = {
    caseName: 'height',
    seed: 0,
    config,
    resolvedScene: [],
    motion,
    motionCost: 4,
    retainedStability: true,
    result: {
      outcome: 'completed',
      reason: 'deadline',
      ticks: 120,
      seconds: 1,
      observations: 10,
      actions: 20,
      final: {
        tick: 120,
        time: 1,
        state: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        target: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        tcps: [],
        actuators: [],
        fingers: [],
        contacts: [],
        blocks: [],
      },
      stableSeconds: 3,
      task,
      controlTicks: 100,
      validationTicks: 20,
      wallSeconds: 1,
      physicsMs: 0,
      observationMs: 0,
      controlMs: 0,
      recordMs: 0,
      evaluation: {
        kind: 'max-height',
        success: false,
        completed: 0,
        total: 0,
        groups: 0,
        totalGroups: 0,
        heightMeters: 0.12,
        stableSeconds: 3,
      },
    },
  };
  const failed = structuredClone(trial);
  failed.seed = 1;
  failed.result.outcome = 'teacher-failed';
  failed.result.evaluation.heightMeters = 0.3;
  failed.motionCost = 0;
  const [summary] = summarizeTeacherTrials([trial, failed]);
  assert.equal(summary.episodes, 2);
  assert.equal(summary.reliability, 0.5);
  assert.equal(summary.height, 0.12 / config.scene.maxStackHeight / 2);
  assert.equal(summary.motion, 4, 'Fast failures cannot lower the successful-motion score');
});
