type ObservationImages = { rgb: Uint8Array; depth?: Uint8Array };
import { calibration } from '../../simulation/sensors/camera';
import type { Config } from '../config';
import {
  PROTOCOL,
  MAX_MESSAGE_BYTES,
  PolicyError,
  validate,
  digest,
  validateProfile,
  profileConfig,
  actualConfig,
  assertCompatible,
  validateAction,
  type Manifest,
  type Message,
} from './contract';
import type { ObservationRow } from '../episode-types';
export type ConnectionOptions = {
  url: string;
  token?: string;
  timeoutMs?: number;
  initializationTimeoutMs?: number;
};
export class PolicySession {
  readonly id = crypto.randomUUID();
  manifest!: Manifest;
  episodeId: string | null = null;
  bound = false;
  fault?: PolicyError;
  onFault?: (error: PolicyError) => void;
  private socket!: WebSocket;
  private sequence = 0;
  private generation = 0;
  private pending = new Map<
    number,
    {
      message: Message;
      expected: string;
      resolve: (m: Message) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private cancelled = new Set<number>();
  private closed = false;
  private latestObservation = 0;
  private constructor(readonly options: ConnectionOptions) {}
  static async connect(options: ConnectionOptions) {
    const session = new PolicySession(options);
    try {
      const url = new URL(options.url);
      if (
        !['ws:', 'wss:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new PolicyError('INVALID_MESSAGE', 'WebSocket URL');
      for (const timeout of [options.timeoutMs ?? 30000, options.initializationTimeoutMs ?? 120000])
        if (!Number.isFinite(timeout) || timeout <= 0)
          throw new PolicyError('INVALID_MESSAGE', 'Timeout');
      const socket = (session.socket = new WebSocket(options.url, PROTOCOL));
      socket.binaryType = 'arraybuffer';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.close();
          reject(new PolicyError('TIMEOUT'));
        }, options.timeoutMs ?? 30000);
        socket.onopen = () => {
          clearTimeout(timer);
          if (socket.protocol !== PROTOCOL) {
            socket.close();
            reject(new PolicyError('PROTOCOL_MISMATCH', `Only ${PROTOCOL} is supported`));
          } else resolve();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new PolicyError('DISCONNECTED'));
        };
        socket.onclose = () => {
          clearTimeout(timer);
          reject(new PolicyError('DISCONNECTED'));
        };
      });
      socket.onmessage = (event) => session.receive(event.data);
      socket.onerror = () => session.fail(new PolicyError('DISCONNECTED'));
      socket.onclose = () => {
        if (!session.closed) session.fail(new PolicyError('DISCONNECTED'));
      };
      const response = await session.request('hello', 'manifest', {
        token: options.token ?? '',
      });
      session.manifest = response.manifest;
      const p = session.manifest.profile;
      validateProfile(p);
      if ((await digest(p)) !== session.manifest.profileHash)
        throw new PolicyError('CONFIG_MISMATCH', 'Profile hash');
      if (session.fault) throw session.fault;
      return session;
    } catch (e) {
      session.close();
      throw e;
    }
  }
  private fail(error: PolicyError) {
    if (this.fault || this.closed) return;
    this.fault = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.socket.close();
    this.onFault?.(error);
  }
  private receive(data: unknown) {
    try {
      if (typeof data !== 'string' || data.length > 65536) throw new PolicyError('INVALID_MESSAGE');
      const m = JSON.parse(data) as Message;
      validate('message', m);
      if (m.sessionId !== this.id) throw new PolicyError('INVALID_MESSAGE', 'Session ID');
      if (this.cancelled.delete(m.requestId)) return;
      const p = this.pending.get(m.requestId);
      if (
        !p ||
        m.episodeId !== p.message.episodeId ||
        (m.type !== 'error' &&
          (m.type !== p.expected || ('tick' in p.message && m.tick !== p.message.tick)))
      )
        throw new PolicyError('INVALID_MESSAGE', 'Unexpected response');
      if (m.type === 'error') throw new PolicyError(m.code, m.params.detail);
      clearTimeout(p.timer);
      this.pending.delete(m.requestId);
      p.resolve(m);
    } catch (e) {
      this.fail(e instanceof PolicyError ? e : new PolicyError('INVALID_MESSAGE'));
    }
  }
  private request(
    type: string,
    expected: string,
    fields: Record<string, unknown> = {},
    frame?: ObservationImages,
    timeout = this.options.timeoutMs ?? 30000,
  ) {
    if (this.closed || this.fault)
      return Promise.reject(this.fault ?? new PolicyError('DISCONNECTED'));
    const m: Message = {
      type,
      sessionId: this.id,
      episodeId: this.episodeId,
      requestId: ++this.sequence,
      ...fields,
    };
    validate('message', m);
    let payload: string | Uint8Array = JSON.stringify(m);
    if (frame) {
      const header = new TextEncoder().encode(payload);
      const bytes = 4 + header.length + frame.rgb.length + (frame.depth?.length ?? 0);
      if (bytes > MAX_MESSAGE_BYTES) throw new PolicyError('INVALID_MESSAGE', 'Message too large');
      const packet = new Uint8Array(bytes);
      new DataView(packet.buffer).setUint32(0, header.length, true);
      packet.set(header, 4);
      packet.set(frame.rgb, 4 + header.length);
      if (frame.depth) packet.set(frame.depth, 4 + header.length + frame.rgb.length);
      payload = packet;
    }
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new PolicyError('TIMEOUT', type)), timeout);
      this.pending.set(m.requestId, { message: m, expected, resolve, reject, timer });
      this.socket.send(payload as string & ArrayBufferView<ArrayBuffer>);
    });
  }
  async bind(config: Config) {
    if (this.bound) throw new PolicyError('INVALID_STATE');
    assertCompatible(this.manifest.profile, config);
    const configuration = profileConfig(config);
    const configurationHash = await digest(configuration);
    const response = await this.request('configure', 'configured', {
      profileHash: this.manifest.profileHash,
      configuration,
      configurationHash,
      calibration: calibration(config.camera, config.environment),
    });
    if (response.configurationHash !== configurationHash) throw new PolicyError('CONFIG_MISMATCH');
    this.bound = true;
  }
  async start(config: Config) {
    assertCompatible(this.manifest.profile, config);
    const generation = this.generation;
    const [configurationHash, profileHash, configHash] = await Promise.all([
      digest(actualConfig(config).configuration),
      digest(this.manifest.profile.config),
      digest(actualConfig(config)),
    ]);
    if (generation !== this.generation) throw new PolicyError('CANCELLED');
    if (!this.bound || this.episodeId || configurationHash !== profileHash)
      throw new PolicyError('CONFIG_MISMATCH');
    this.episodeId = crypto.randomUUID();
    this.latestObservation = 0;
    await this.request(
      'episode_start',
      'episode_ready',
      { actual: actualConfig(config), configHash },
      undefined,
      this.options.initializationTimeoutMs ?? 120000,
    );
  }
  async observe(row: ObservationRow, frame: ObservationImages) {
    const m = await this.request(
      'observation',
      'observed',
      {
        tick: row.tick,
        time: row.time,
        state: row.state,
        cameraToWorld: row.cameraToWorld,
        rgbBytes: frame.rgb.length,
        depthBytes: frame.depth?.length ?? 0,
      },
      frame,
    );
    this.latestObservation = m.requestId;
  }
  async act(tick: number, dt: number) {
    const m = await this.request('act', 'action', {
      tick,
      dt,
      observationId: this.latestObservation,
    });
    validateAction(m.action, this.manifest.profile.config);
    return {
      action: m.action as import('../../simulation/world/types').Action16D,
      continuous: m.continuous as boolean,
    };
  }
  cancelPending() {
    this.generation++;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.cancelled.add(id);
      p.reject(new PolicyError('CANCELLED'));
    }
    this.pending.clear();
  }
  async end(summary: { outcome: string; reason: string; ticks: number; seconds: number }) {
    if (!this.episodeId || this.closed || this.fault) return;
    await this.request('episode_end', 'episode_ended', { summary });
    this.episodeId = null;
  }
  close() {
    this.closed = true;
    this.cancelPending();
    this.socket?.close();
  }
}
