import { appearanceIdentity } from '../appearance';
import type { ThemeId } from '../theme-catalog';
import type { Config } from '../config';
import { resolveEpisode, type ResolvedEpisode } from '../plan';
import type {
  ActionSource,
  EpisodeSink,
  EpisodeResult,
  ObservationRow,
  ActionRow,
  DiagnosticRow,
} from '../episode-types';
import { BodyView, WorldView } from '../../simulation/world/view';
import type { Outcome } from '../../simulation/world/types';
import {
  HOST_PROTOCOL_VERSION,
  SINK_METHODS,
  type EpisodeFrame,
  type EpisodeOpened,
} from '../host-protocol';
import { Connection } from './rpc';

export type ControlMode =
  | { kind: 'teacher' }
  | { kind: 'manual'; keys: Set<string> }
  | { kind: 'client'; name: string; create(sim: WorldView, config: Config): ActionSource };

type ClientControl =
  | { kind: 'teacher'; teacher: NonNullable<EpisodeFrame['teacher']> }
  | { kind: 'manual'; keys: Set<string>; holdSerial: number }
  | { kind: 'client'; actions: ActionSource };

export class EpisodeClient {
  readonly sim: WorldView;
  readonly config: Config;
  appearance;
  readonly source: ClientControl;
  score: EpisodeFrame['score'];
  result: EpisodeResult | null = null;
  phase = 'idle';
  stage: EpisodeFrame['stage'] = 'active';
  observations = 0;
  actions = 0;
  private completion: Promise<void> = Promise.resolve();
  private pauseAcknowledgement: Promise<void> = Promise.resolve();
  private fault?: Error;
  private constructor(
    private connection: Connection,
    config: Config,
    opened: EpisodeOpened,
    resolved: ResolvedEpisode,
    mode: ControlMode,
    private sink?: EpisodeSink,
  ) {
    this.config = structuredClone(resolved.config);
    this.appearance = appearanceIdentity(config.appearance.theme);
    this.sim = new WorldView(
      { environment: resolved.config.environment, scene: resolved.resolvedScene },
      opened.metadata,
      opened.frame.physics,
      (view, id) => new BodyView(view, id),
    );
    this.score = opened.frame.score;
    switch (mode.kind) {
      case 'teacher':
        this.source = { kind: 'teacher', teacher: opened.frame.teacher! };
        break;
      case 'manual':
        this.source = { ...mode, holdSerial: 0 };
        break;
      case 'client': {
        const actions = mode.create(this.sim, this.config);
        actions.reset();
        this.source = { kind: 'client', actions };
        break;
      }
    }
    this.update(opened.frame);
    connection.handler = (method, payload) => this.receive(method, payload);
  }
  static async create(
    config: Config,
    mode: ControlMode,
    sink?: EpisodeSink,
    resolved: ResolvedEpisode = resolveEpisode(config),
    recording?: string,
  ) {
    const connection = await Connection.connect();
    try {
      const opened = await connection.request<EpisodeOpened>('open', {
        version: HOST_PROTOCOL_VERSION,
        config,
        plan: resolved,
        source: mode.kind,
        name: mode.kind === 'client' ? mode.name : mode.kind,
        sink: SINK_METHODS.filter((key) => typeof sink?.[key] === 'function'),
        ...(recording ? { recording } : {}),
      });
      return new EpisodeClient(connection, config, opened, resolved, mode, sink);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  private update(frame: EpisodeFrame) {
    this.sim.frame = frame.physics;
    this.score = frame.score;
    this.result = frame.result;
    this.phase = frame.phase;
    this.stage = frame.stage;
    this.observations = frame.observations;
    this.actions = frame.actions;
    if (this.source.kind === 'teacher' && frame.teacher)
      Object.assign(this.source.teacher, frame.teacher);
  }
  private call<T = void>(method: string, payload: unknown = null): Promise<T> {
    if (this.fault) return Promise.reject(this.fault);
    return this.connection.request<T>(method, payload);
  }
  private async receive(method: string, received: unknown) {
    const payload = received as { data: unknown; frame: EpisodeFrame };
    this.update(payload.frame);
    const actions = this.source.kind === 'client' ? this.source.actions : undefined;
    if (method.startsWith('source.') && !actions)
      throw new Error('Unexpected client action callback');
    let value: unknown;
    switch (method) {
      case 'source.initialize':
        value = await actions!.initialize?.();
        break;
      case 'source.observe':
        value = await actions!.observe?.(payload.data as ObservationRow);
        break;
      case 'source.next':
        value = await actions!.next(payload.data as number);
        break;
      case 'source.cancel':
        actions!.cancel?.();
        break;
      case 'source.end':
        value = await actions!.end(payload.data as EpisodeResult);
        break;
      case 'sink.observation':
        value = await this.sink!.observation!(payload.data as ObservationRow);
        break;
      case 'sink.action':
        value = await this.sink!.action!(payload.data as ActionRow);
        break;
      case 'sink.diagnostic':
        value = await this.sink!.diagnostic!(payload.data as DiagnosticRow);
        break;
      default:
        throw new Error(`Unknown host callback: ${method}`);
    }
    return value;
  }
  async step() {
    const input =
      this.source.kind === 'manual'
        ? { keys: [...this.source.keys], holdSerial: this.source.holdSerial }
        : {};
    this.update(await this.call<EpisodeFrame>('step', input));
  }
  async advance(ticks: number) {
    const before = this.sim.ticks;
    this.update(await this.call<EpisodeFrame>('advance', { ticks }));
    return this.sim.ticks - before;
  }
  pause() {
    this.pauseAcknowledgement = this.call<EpisodeFrame>('pause').then((frame) =>
      this.update(frame),
    );
    void this.pauseAcknowledgement.catch((error: Error) => {
      this.fault = error;
    });
  }
  resume() {
    void this.call('resume').catch((error: Error) => {
      this.fault = error;
    });
  }
  finish(outcome: Outcome, reason: string) {
    if (this.result) return;
    this.completion = this.call<EpisodeFrame>('finish', { outcome, reason }).then((frame) =>
      this.update(frame),
    );
    void this.completion.catch(() => {});
  }
  async settled() {
    await this.pauseAcknowledgement;
    await this.completion;
    this.update(await this.call<EpisodeFrame>('settled'));
  }
  setAppearance(theme: ThemeId) {
    if (this.sim.ticks !== 0 || this.result) return false;
    this.config.appearance = { theme };
    this.appearance = appearanceIdentity(theme);
    void this.call('appearance', theme).catch((error: Error) => {
      this.fault = error;
    });
    return true;
  }
  async run() {
    try {
      this.update(await this.call<EpisodeFrame>('run'));
    } catch (error) {
      if ((this.result as EpisodeResult | null)?.outcome !== 'stopped') throw error;
    }
    await this.settled();
    return this.result!;
  }
  dispose() {
    void this.call('dispose')
      .catch((error: Error) => {
        this.fault = error;
      })
      .finally(() => this.connection.close());
  }
}
