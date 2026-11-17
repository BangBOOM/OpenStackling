import { resolveEpisode, type ResolvedEpisode } from '../plan';
import type { Config } from '../config';
import { WorldScene } from './render/rendering';
import { SensorCamera } from './render/camera';
import type { EpisodeSink } from '../episode-types';
import { EpisodeClient } from '../client/episode-client';
import { FramePipeline } from './frame-pipeline';
import { PolicySession, type ConnectionOptions } from '../policy/session';
import { ExternalPolicySource } from '../policy/source';
import { pack, type PacketRow } from '../recording/protocol';
import { ReplaySource } from '../recording/replay-source';
import type { ActionRow } from '../episode-types';
const MAX_BYTES = 8 * 1024 * 1024,
  BATCH_BYTES = 512 * 1024;
let active: EpisodeClient | undefined;
let retained: { episode: EpisodeClient; scene: WorldScene; sensor: SensorCamera } | undefined;
let policy: PolicySession | undefined;
const api = {
  async connectPolicy(options: ConnectionOptions) {
    policy = await PolicySession.connect(options);
    return policy.manifest;
  },
  async bindPolicy(config: Config) {
    await policy!.bind(config);
  },
  disconnectPolicy() {
    policy?.close();
    policy = undefined;
  },
  stop() {
    active?.finish('stopped', 'user interrupted');
  },
  dispose() {
    if (retained) {
      retained.sensor.dispose();
      retained.scene.dispose();
      retained.episode.dispose();
      retained = undefined;
    }
  },
  async run(
    config: Config,
    url?: string,
    replay?: ActionRow[],
    resolved: ResolvedEpisode = resolveEpisode(config),
    hostRecording?: string,
  ) {
    const recording = url !== undefined;
    const visual = new URLSearchParams(location.search).has('visual');
    let reusable: SensorCamera | undefined;
    if (retained) {
      if (
        retained.sensor.config.width === config.camera.width &&
        retained.sensor.config.heightPixels === config.camera.heightPixels &&
        retained.sensor.config.depth === config.camera.depth
      )
        reusable = retained.sensor;
      else retained.sensor.dispose();
      retained.scene.dispose();
      retained.episode.dispose();
      retained = undefined;
    }
    let frames: FramePipeline;
    let rows: PacketRow[] = [],
      bytes = 0,
      queuedBytes = 0,
      peakQueuedBytes = 0,
      chain = Promise.resolve(),
      error: unknown,
      networkMs = 0;
    const start = performance.now();
    const flush = async () => {
      if (!rows.length) return;
      const packet = pack(rows);
      rows = [];
      bytes = 0;
      const t = performance.now();
      const response = await fetch(url!, {
        method: 'POST',
        body: packet.buffer as ArrayBuffer,
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(await response.text());
      networkMs += performance.now() - t;
    };
    const enqueue = (job: Promise<PacketRow>, rawBytes = 0) => {
      void job.catch((e) => {
        error = e;
      });
      queuedBytes += rawBytes;
      peakQueuedBytes = Math.max(peakQueuedBytes, queuedBytes);
      chain = chain
        .then(async () => {
          const row = await job;
          rows.push(row);
          if (row.kind === 'observation') bytes += row.depth?.length ?? 0;
          else if (row.kind === 'video') bytes += row.data.length;
          else bytes += 1024;
          if (bytes >= BATCH_BYTES) await flush();
          queuedBytes -= rawBytes;
        })
        .catch((e) => {
          error = e;
        });
    };
    let sensor: SensorCamera;
    const sink: EpisodeSink = {
      async observation(row) {
        if (error) throw error;
        const encoded = frames.sample(row.tick);
        if (new URLSearchParams(location.search).has('visual'))
          sensor.worldScene.render(sensor.renderer, sensor.camera);
        const size =
          config.camera.width * config.camera.heightPixels * (config.camera.depth ? 8 : 4);
        enqueue(
          encoded.then(
            (frame) => ({ kind: 'observation', row, depth: frame.gzDepth }) as PacketRow,
          ),
          size,
        );
        if (queuedBytes >= MAX_BYTES) await chain;
        if (error) throw error;
      },
      action(row) {
        enqueue(Promise.resolve({ kind: 'action', row }));
      },
      diagnostic(row) {
        enqueue(Promise.resolve({ kind: 'diagnostic', row }));
      },
    };
    const episode = await EpisodeClient.create(
      config,
      replay
        ? { kind: 'client', name: 'replay', create: (s) => new ReplaySource(s, replay) }
        : policy
          ? {
              kind: 'client',
              name: 'external-policy',
              create: (s, applied) =>
                new ExternalPolicySource(s, policy!, (tick) => frames.sample(tick), applied),
            }
          : { kind: 'teacher' },
      recording
        ? sink
        : visual
          ? {
              observation() {
                sensor.worldScene.render(sensor.renderer, sensor.camera);
              },
            }
          : undefined,
      resolved,
      hostRecording,
    );
    active = episode;
    const scene = new WorldScene(episode.sim, config.appearance.theme, config.camera.head.pitch);
    sensor = reusable ?? new SensorCamera(scene, config.camera);
    if (reusable) sensor.rebind(scene, config.camera);
    frames = new FramePipeline(
      sensor,
      { physicsHz: config.environment.physicsHz, observationHz: config.run.observationHz },
      { video: recording, png: Boolean(policy) },
    );
    retained = { episode, scene, sensor };
    if (!sensor.renderer.domElement.isConnected) {
      document.querySelector('canvas')?.remove();
      document.body.append(sensor.renderer.domElement);
    }
    try {
      const codec = await frames.startEpisode();
      const result = await episode.run();
      await chain;
      if (error) throw error;
      if (recording) {
        const mp4 = await frames.endEpisode();
        enqueue(Promise.resolve({ kind: 'video', data: mp4, codec: codec! }), mp4.length);
      }
      await chain;
      if (error) throw error;
      await flush();
      return {
        result,
        metrics: {
          sensorFrames: sensor.frames,
          renderMs: sensor.renderMs,
          readbackMs: sensor.readbackMs,
          encodeMs: frames.encoder.encodeMs,
          networkMs,
          peakQueuedBytes,
          wallSeconds: (performance.now() - start) / 1000,
        },
      };
    } catch (failure) {
      frames.abortEpisode();
      await chain;
      if (!error) await flush();
      throw failure;
    } finally {
      frames.dispose();
      active = undefined;
    }
  },
};
Object.assign(window, { stackling: api });
