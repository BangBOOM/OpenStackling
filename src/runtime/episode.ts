import type {
  ActionRow,
  ActionSource,
  ObservationRow,
  EpisodeResult,
  EpisodeSink,
} from './episode-types';
import { Simulation } from '../simulation/world/simulation';
import { TaskScore } from '../simulation/tasks/registry';
import { actionLimits } from '../simulation/world/actions';
import { makeCamera } from '../simulation/sensors/camera';
import { resolveEpisode, type ResolvedEpisode } from './plan';
import type { Config } from './config';
import { appearanceIdentity, type AppearanceIdentity } from './appearance';
import { type ThemeId } from './theme-catalog';
import type { Action, Outcome } from '../simulation/world/types';
export class Episode {
  readonly sim: Simulation;
  readonly config: Config;
  appearance: AppearanceIdentity;
  readonly score: TaskScore;
  source: ActionSource;
  result: EpisodeResult | null = null;
  phase = 'idle';
  stage: 'active' | 'validating' | 'finished' = 'active';
  private holdAction?: Action;
  private validationStarted = 0;
  observations = 0;
  actions = 0;
  private initialized = false;
  private completion: Promise<void> = Promise.resolve();
  private pauseGate?: Promise<void>;
  private resumeGate?: () => void;
  get paused() {
    return this.pauseGate !== undefined;
  }
  pause() {
    if (!this.pauseGate)
      this.pauseGate = new Promise((resolve) => {
        this.resumeGate = resolve;
      });
  }
  resume() {
    this.resumeGate?.();
    this.pauseGate = undefined;
    this.resumeGate = undefined;
  }
  async settled() {
    await this.completion;
  }
  private started = performance.now();
  private timings = { physicsMs: 0, observationMs: 0, controlMs: 0, recordMs: 0 };
  constructor(
    config: Config,
    sourceFactory: (sim: Simulation, config: Config) => ActionSource,
    private sink?: EpisodeSink,
    resolved: ResolvedEpisode = resolveEpisode(config),
    private readonly yieldControl?: () => Promise<void> | undefined,
  ) {
    this.config = structuredClone(resolved.config);
    this.appearance = appearanceIdentity(config.appearance.theme);
    this.sim = new Simulation({
      environment: this.config.environment,
      scene: resolved.resolvedScene,
    });
    this.score = new TaskScore(this.sim, resolved.task);
    this.source = sourceFactory(this.sim, this.config);
    this.source.reset();
  }
  setAppearance(theme: ThemeId) {
    if (this.initialized || this.result || this.sim.ticks !== 0) return false;
    this.config.appearance = { theme };
    this.appearance = appearanceIdentity(theme);
    return true;
  }
  finish(outcome: Outcome, reason: string) {
    if (this.result) return;
    this.resume();
    if (outcome === 'stopped') this.source.cancel?.();
    this.stage = 'finished';
    this.result = {
      outcome,
      reason,
      ticks: this.sim.ticks,
      seconds: this.sim.time,
      observations: this.observations,
      actions: this.actions,
      final: this.sim.inspect(),
      stableSeconds: this.score.stableSeconds,
      evaluation: structuredClone(this.score.evaluation),
      task: structuredClone(this.score.task),
      controlTicks: this.validationStarted || this.sim.ticks,
      validationTicks: this.validationStarted ? this.sim.ticks - this.validationStarted : 0,
      wallSeconds: (performance.now() - this.started) / 1000,
      ...this.timings,
    };
    this.completion = Promise.resolve(this.source.end(this.result));
    void this.completion.catch(() => {});
  }
  async step() {
    if (this.result) return;
    if (!this.initialized) {
      this.initialized = true;
      await this.source.initialize?.();
    }
    await this.pauseGate;
    if (this.result) return;
    const s = this.sim,
      c = this.config;
    if (s.ticks % (c.environment.physicsHz / c.run.observationHz) === 0) {
      const t = performance.now();
      const row: ObservationRow = {
        tick: s.ticks,
        time: s.time,
        state: s.state(),
        cameraToWorld: makeCamera(
          c.camera,
          c.environment,
          s.body.transform(),
        ).matrixWorld.toArray(),
      };
      if (this.stage === 'active') await this.source.observe?.(row);
      if (this.result) return;
      await this.sink?.observation?.(row);
      this.timings.observationMs += performance.now() - t;
      this.observations++;
      if (this.result) return;
    }
    if (s.ticks % (c.environment.physicsHz / c.run.controlHz) === 0) {
      const t = performance.now(),
        advice =
          this.stage === 'validating'
            ? { action: this.holdAction!, valid: true, reason: '', phase: 'evaluation-hold' }
            : await this.source.next(1 / c.run.controlHz);
      this.timings.controlMs += performance.now() - t;
      if (this.result) return;
      await this.pauseGate;
      if (this.result) return;
      this.phase = advice.phase;
      if (!advice.valid) {
        s.step();
        this.score.update();
        this.finish('teacher-failed', advice.reason);
        return;
      }
      const row: ActionRow = {
        tick: s.ticks,
        time: s.time,
        executed_action: advice.action,
        controller: this.stage === 'validating' ? 'evaluation-hold' : this.source.name,
        label_valid: this.stage === 'active' && this.source.name === 'teacher',
        continuous: advice.continuous ?? false,
      };
      if (row.label_valid) row.teacher_action = [...advice.action];
      const recordStart = performance.now();
      await this.sink?.action?.(row);
      await this.sink?.diagnostic?.({
        tick: s.ticks,
        time: s.time,
        phase: this.phase,
        snapshot: s.inspect(),
      });
      this.timings.recordMs += performance.now() - recordStart;
      if (this.result) return;
      await this.pauseGate;
      if (this.result) return;
      s.apply(advice.action, advice.continuous);
      this.actions++;
    }
    await this.pauseGate;
    if (this.result) return;
    const t = performance.now();
    s.step();
    this.timings.physicsMs += performance.now() - t;
    if (this.stage === 'active') {
      let controlStart = performance.now();
      const work = this.source.afterStep?.();
      if (work)
        for (const _ of work) {
          const wait = this.yieldControl?.();
          if (wait) {
            this.timings.controlMs += performance.now() - controlStart;
            await wait;
            await this.pauseGate;
            if (this.result) return;
            controlStart = performance.now();
          }
        }
      this.timings.controlMs += performance.now() - controlStart;
    }
    this.score.update();
    if (this.stage === 'validating') {
      if (
        s.ticks - this.validationStarted >=
        Math.ceil(this.score.task.validationSeconds * c.environment.physicsHz)
      )
        this.finish('completed', 'final task evaluation');
    } else if (this.score.success) this.finish('success', 'task complete');
    else if (s.time + 1e-9 >= c.run.maxSeconds) {
      if (this.score.task.mode === 'deadline') {
        this.stage = 'validating';
        this.validationStarted = s.ticks;
        const state = s.state();
        const limits = actionLimits(c.environment.robot);
        this.holdAction = state.map((v, i) =>
          Math.max(limits[i][0], Math.min(limits[i][1], v)),
        ) as Action;
        s.apply(this.holdAction);
        this.score.beginValidation();
      } else this.finish('timeout', 'episode time limit');
    } else if (this.source.failure) this.finish('teacher-failed', this.source.failure);
  }
  async run() {
    while (!this.result) {
      try {
        await this.step();
      } catch (e) {
        if ((this.result as EpisodeResult | null)?.outcome !== 'stopped') throw e;
      }
      if (this.sim.ticks % 240 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await this.settled();
    return this.result;
  }
  dispose() {
    this.sim.dispose();
  }
}
