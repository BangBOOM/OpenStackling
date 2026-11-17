import { teacherSource } from '../host/teacher-source';
import { resolveConfig, type Config } from '../config';
import { Episode } from '../episode';
import { type EpisodeResult } from '../episode-types';
import { resolveEpisode } from '../plan';
import type { SceneRequest } from '../../simulation/scene';
import { type Simulation } from '../../simulation/world/simulation';
import type { ResolvedScene } from '../../simulation/world/objects';
import type { Vec3 } from '../../simulation/world/types';
import type { TeacherPolicy } from '../../simulation/control/teacher-policy';

export const MOTION_METRICS_VERSION = 1;
export type MotionMetrics = {
  samples: number;
  seconds: number;
  waistTravel: number;
  waistReversals: number;
  waistYawTravel: number;
  waistPitchTravel: number;
  waistYawReversals: number;
  waistPitchReversals: number;
  armJointTravel: number;
  jointAccelerationVariation: number;
  tcpTravel: number;
  idleSeconds: number;
};
export type MotionSample = { time: number; state: number[]; tcp: Vec3[]; working: boolean };

// Measured states at 10 Hz, with a 0.2 s velocity low-pass and 0.03 rad reversal deadband.
// Acceleration variation is the total variation of filtered angular acceleration, in rad/s².
export class MeasuredMotion {
  private previous?: MotionSample;
  private velocities: number[] = [];
  private accelerations: number[] = [];
  private direction = [0, 0];
  private extreme = [0, 0];
  private metrics: MotionMetrics = {
    samples: 0,
    seconds: 0,
    waistTravel: 0,
    waistReversals: 0,
    waistYawTravel: 0,
    waistPitchTravel: 0,
    waistYawReversals: 0,
    waistPitchReversals: 0,
    armJointTravel: 0,
    jointAccelerationVariation: 0,
    tcpTravel: 0,
    idleSeconds: 0,
  };

  sample(sim: Simulation, working = true) {
    this.metrics.seconds = sim.time;
    if (sim.ticks % (sim.config.environment.physicsHz / 10) !== 0) return;
    this.observe({
      time: sim.time,
      state: sim.state(),
      tcp: sim.arms.map((arm) => arm.pose()),
      working,
    });
  }

  observe(sample: MotionSample) {
    const previous = this.previous;
    this.metrics.seconds = sample.time;
    this.metrics.samples++;
    if (!previous) {
      this.extreme = sample.state.slice(0, 2);
      this.previous = structuredClone(sample);
      return;
    }
    const dt = sample.time - previous.time;
    const angles = sample.state.map((_, i) => i).filter((i) => ![8, 15].includes(i));
    let angularSpeed = 0;
    const nextVelocity: number[] = [],
      nextAcceleration: number[] = [];
    for (const [joint, index] of angles.entries()) {
      const velocity = (sample.state[index] - previous.state[index]) / dt;
      if (index >= 2)
        this.metrics.armJointTravel += Math.abs(sample.state[index] - previous.state[index]);
      angularSpeed = Math.max(angularSpeed, Math.abs(velocity));
      const oldVelocity = this.velocities[joint] ?? 0;
      const filtered = oldVelocity + (dt / (0.2 + dt)) * (velocity - oldVelocity);
      const acceleration = (filtered - oldVelocity) / dt;
      if (this.accelerations.length)
        this.metrics.jointAccelerationVariation += Math.abs(
          acceleration - this.accelerations[joint],
        );
      nextVelocity.push(filtered);
      nextAcceleration.push(acceleration);
    }
    this.velocities = nextVelocity;
    this.accelerations = nextAcceleration;
    for (let i = 0; i < 2; i++) {
      const value = sample.state[i];
      this.metrics.waistTravel += Math.abs(value - previous.state[i]);
      this.metrics[i === 0 ? 'waistYawTravel' : 'waistPitchTravel'] += Math.abs(
        value - previous.state[i],
      );
      if (!this.direction[i]) {
        if (Math.abs(value - this.extreme[i]) >= 0.03) {
          this.direction[i] = Math.sign(value - this.extreme[i]);
          this.extreme[i] = value;
        }
      } else if ((value - this.extreme[i]) * this.direction[i] >= 0) {
        this.extreme[i] = value;
      } else if ((this.extreme[i] - value) * this.direction[i] >= 0.03) {
        this.metrics.waistReversals++;
        this.metrics[i === 0 ? 'waistYawReversals' : 'waistPitchReversals']++;
        this.direction[i] *= -1;
        this.extreme[i] = value;
      }
    }
    const distance = sample.tcp.reduce((sum, p, i) => {
      const q = previous.tcp[i];
      return sum + Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    }, 0);
    this.metrics.tcpTravel += distance;
    if (sample.working && previous.working && distance / dt < 0.005 && angularSpeed < 0.02)
      this.metrics.idleSeconds += dt;
    this.previous = structuredClone(sample);
  }

  snapshot(): MotionMetrics {
    return { ...this.metrics };
  }
}

// Fixed evaluation weights are deliberately separate from the parameters being optimized.
export function motionCost(m: MotionMetrics) {
  return (
    m.waistTravel +
    0.25 * m.waistReversals +
    (0.04 * m.jointAccelerationVariation) / 14 +
    0.5 * m.tcpTravel +
    0.03 * m.idleSeconds +
    0.005 * m.seconds
  );
}

export type TeacherCase = { name: string; config: Config; generation?: SceneRequest };
export type TeacherTrial = {
  caseName: string;
  seed: number;
  config: Config;
  resolvedScene: ResolvedScene;
  result: EpisodeResult;
  motion: MotionMetrics;
  motionCost: number;
  retainedStability: boolean;
};

export async function evaluateTeacherCase(
  entry: TeacherCase,
  seed: number,
  policy: TeacherPolicy,
): Promise<TeacherTrial> {
  const config = resolveConfig(entry.config, { run: { seed }, teacher: { policy } });
  const resolved = resolveEpisode(config, entry.generation);
  const episode = new Episode(config, teacherSource, undefined, resolved);
  const motion = new MeasuredMotion();
  try {
    motion.sample(episode.sim);
    while (!episode.result) {
      await episode.step();
      motion.sample(episode.sim, episode.stage === 'active' && episode.phase !== 'success');
    }
    let retainedStability = true;
    if (episode.result.outcome === 'success')
      for (let i = 0; i < config.environment.physicsHz * 10; i++) {
        episode.sim.step();
        episode.score.update();
        if (!episode.score.stable) retainedStability = false;
      }
    const measured = motion.snapshot();
    return {
      caseName: entry.name,
      seed,
      config: resolved.config,
      resolvedScene: resolved.resolvedScene,
      result: episode.result,
      motion: measured,
      motionCost: motionCost(measured),
      retainedStability,
    };
  } finally {
    episode.dispose();
  }
}

export type CaseQuality = {
  name: string;
  episodes: number;
  reliability: number;
  mode: 'completion' | 'deadline';
  height: number;
  motion: number;
};
export function summarizeTeacherTrials(rows: TeacherTrial[]): CaseQuality[] {
  return [...new Set(rows.map((row) => row.caseName))].sort().map((name) => {
    const selected = rows.filter((row) => row.caseName === name);
    const mode = selected[0].result.task.mode;
    const successful = (row: TeacherTrial) =>
      mode === 'deadline'
        ? row.result.outcome === 'completed'
        : row.result.outcome === 'success' && row.retainedStability;
    return {
      name,
      episodes: selected.length,
      mode,
      reliability: selected.filter(successful).length / selected.length,
      // Failed deadline episodes contribute zero; no failed seed disappears from the denominator.
      height:
        selected.reduce(
          (sum, row) =>
            sum +
            (mode === 'deadline' && successful(row)
              ? row.result.evaluation.heightMeters / row.config.scene.maxStackHeight
              : 0),
          0,
        ) / selected.length,
      motion:
        selected.filter(successful).reduce((sum, row) => sum + row.motionCost, 0) /
        Math.max(1, selected.filter(successful).length),
    };
  });
}

export function noTaskRegression(candidate: CaseQuality[], baseline: CaseQuality[]) {
  return baseline.every((reference) => {
    const current = candidate.find((entry) => entry.name === reference.name)!;
    return (
      current.reliability >= reference.reliability &&
      (reference.mode !== 'deadline' || current.height + 1e-9 >= reference.height)
    );
  });
}

// Negative means a is preferable: reliability first, final stable height next, motion last.
export function compareTeacherQuality(a: CaseQuality[], b: CaseQuality[]) {
  const sum = (rows: CaseQuality[], key: 'reliability' | 'height' | 'motion') =>
    rows.reduce((total, row) => total + row[key], 0);
  return (
    sum(b, 'reliability') - sum(a, 'reliability') ||
    sum(b, 'height') - sum(a, 'height') ||
    sum(a, 'motion') - sum(b, 'motion')
  );
}
