import { HostRecording } from './recording';
import type { PacketRow } from '../recording/protocol';
import { encodeHostMessage, decodeHostMessage, type HostData } from '../host-wire';
import { teacherSource } from './teacher-source';
import { isManualKey } from '../../simulation/control/manual-keys';
import { resolveConfig } from '../config';
import { isDeepStrictEqual } from 'node:util';
import { resolveEpisode } from '../plan';
import { Simulation } from '../../simulation/world/simulation';
import type { WorldConfig } from '../../simulation/world/config';
import { Episode } from '../episode';
import { type ActionSource, type EpisodeSink, type Advice } from '../episode-types';
import { TeacherSource } from './teacher-source';
import { Manual } from '../../simulation/control/manual';
import {
  HOST_PROTOCOL_VERSION,
  SINK_METHODS,
  rpcError,
  type EpisodeFrame,
  type OpenEpisode,
  type RpcMessage,
} from '../host-protocol';

export function session(
  sendRaw: (data: HostData) => void,
  record: (id: string, rows: PacketRow[]) => Promise<void> = async () => {
    throw new Error('Host recording is unavailable');
  },
) {
  let closed = false;
  let episode: Episode | undefined;
  let world: Simulation | undefined;
  let sequence = -1;
  let deadline = 0;
  let stepping = false;
  let manual: Manual | undefined;
  let recording: HostRecording | undefined;
  let holdSerial = 0;
  const keys = new Set<string>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const send = (message: RpcMessage) => sendRaw(encodeHostMessage(message));
  const frame = (): EpisodeFrame => ({
    physics: episode!.sim.frame,
    phase: episode!.phase,
    stage: episode!.stage,
    result: episode!.result,
    observations: episode!.observations,
    actions: episode!.actions,
    score: {
      task: episode!.score.task,
      evaluation: episode!.score.evaluation,
      stableSeconds: episode!.score.stableSeconds,
      success: episode!.score.success,
    },
    ...(episode!.source instanceof TeacherSource
      ? {
          teacher: {
            phase: episode!.source.teacher.phase,
            reason: episode!.source.teacher.reason,
            decisions: episode!.source.teacher.decisions,
          },
        }
      : {}),
  });
  const callback = <T = void>(method: string, payload: unknown) =>
    new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(new Error('Host connection closed'));
        return;
      }
      const id = sequence--;
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      send({ id, method, payload: { data: payload, frame: frame() } });
    });
  const receive = async (bytes: HostData) => {
    const message = decodeHostMessage(bytes);
    if (!Number.isSafeInteger(message.id)) throw new Error('Invalid host request ID');
    if (!('method' in message)) {
      const call = pending.get(message.id);
      if (!call) throw new Error('Unknown host callback');
      pending.delete(message.id);
      if (message.error)
        call.reject(Object.assign(new Error(message.error.message), message.error));
      else call.resolve(message.value);
      return;
    }
    const { id, method } = message;
    try {
      let value: unknown;
      switch (method) {
        case 'world.open': {
          if (episode || world) throw new Error('A world is already open');
          const request = message.payload as { version: number; config: WorldConfig };
          if (request.version !== HOST_PROTOCOL_VERSION)
            throw new Error('Unsupported host protocol');
          world = new Simulation(request.config);
          value = { metadata: world.metadata, frame: world.frame };
          break;
        }
        case 'world.step':
          world!.step();
          value = world!.frame;
          break;
        case 'world.apply': {
          const input = message.payload as {
            action: import('../../simulation/world/types').Action;
            continuous: boolean;
          };
          world!.apply(input.action, input.continuous);
          value = world!.frame;
          break;
        }
        case 'world.body': {
          const input = message.payload as { index: number; values: Record<string, unknown> };
          world!.setBody(world!.bodies[input.index].id, input.values);
          value = world!.frame;
          break;
        }
        case 'world.dispose':
          world!.dispose();
          world = undefined;
          break;
        case 'open': {
          if (episode || world) throw new Error('An episode/world is already open');
          const request = message.payload as OpenEpisode;
          if (
            request.version !== HOST_PROTOCOL_VERSION ||
            !['teacher', 'manual', 'client'].includes(request.source) ||
            !Array.isArray(request.sink) ||
            !request.sink.every((key) => SINK_METHODS.includes(key))
          )
            throw new Error('Unsupported host protocol/source');
          const config = resolveConfig(request.config);
          const resolved = resolveEpisode(config);
          for (const key of ['config', 'resolvedScene', 'task', 'appearance'] as const)
            if (!isDeepStrictEqual(request.plan[key], resolved[key]))
              throw new Error(`Episode plan mismatch: ${key}`);
          let source: (sim: Episode['sim'], config: typeof resolved.config) => ActionSource =
            teacherSource;
          if (request.source === 'manual') source = (sim) => (manual = new Manual(sim, keys));
          if (request.source === 'client')
            source = () => ({
              name: request.name,
              reset() {},
              initialize: () => callback('source.initialize', null),
              observe: (row) => callback('source.observe', row),
              next: (dt) => callback<Advice>('source.next', dt),
              cancel() {
                void callback('source.cancel', null).catch(() => {});
              },
              end: (result) => callback('source.end', result),
            });
          if (request.recording) {
            if (!request.sink.includes('observation'))
              throw new Error('Host recording requires a sensor sink');
            await record(request.recording, []);
            recording = new HostRecording((rows) => record(request.recording!, rows));
          }
          const sink: EpisodeSink = {};
          if (request.sink.includes('observation'))
            sink.observation = (row) => callback('sink.observation', row);
          if (recording) {
            sink.action = (row) => recording!.action(row);
            sink.diagnostic = (row) => recording!.diagnostic(row);
          } else {
            if (request.sink.includes('action'))
              sink.action = (row) => callback('sink.action', row);
            if (request.sink.includes('diagnostic'))
              sink.diagnostic = (row) => callback('sink.diagnostic', row);
          }
          episode = new Episode(config, source, sink, request.plan, () => {
            if (performance.now() < deadline) return;
            return new Promise<void>((resolve) =>
              setTimeout(() => {
                deadline = performance.now() + 8;
                resolve();
              }, 0),
            );
          });
          value = { metadata: episode.sim.metadata, frame: frame() };
          break;
        }
        case 'run': {
          if (!episode || stepping) throw new Error('No open episode or concurrent run');
          stepping = true;
          try {
            await episode.run();
            await recording?.flush();
            value = frame();
          } finally {
            stepping = false;
          }
          break;
        }
        case 'step':
        case 'advance': {
          if (!episode || stepping) throw new Error('No open episode or concurrent step');
          const batch = method === 'advance';
          const input = message.payload as {
            keys?: string[];
            holdSerial?: number;
            ticks?: number;
          };
          const ticks = batch ? input.ticks! : 1;
          if (batch) {
            if (!(episode.source instanceof TeacherSource))
              throw new Error('Only host teachers support batched steps');
            if (!Number.isSafeInteger(ticks) || ticks <= 0)
              throw new Error('Invalid advance ticks');
          }
          stepping = true;
          try {
            if (manual) {
              if (!input.keys?.every((key) => isManualKey(key)))
                throw new Error('Invalid manual keys');
              keys.clear();
              for (const key of input.keys) keys.add(key);
              if (input.holdSerial !== holdSerial) {
                manual.hold();
                holdSerial = input.holdSerial!;
              }
            }
            deadline = performance.now() + 8;
            for (
              let tick = 0;
              tick < ticks && !episode.result && (!batch || !episode.paused);
              tick++
            ) {
              await episode.step();
              if (batch && performance.now() >= deadline) break;
            }
            value = frame();
          } finally {
            stepping = false;
          }
          break;
        }
        case 'pause':
          episode!.pause();
          value = frame();
          break;
        case 'resume':
          episode!.resume();
          break;
        case 'finish': {
          const input = message.payload as { outcome: 'stopped'; reason: string };
          if (input.outcome !== 'stopped')
            throw new Error('Only user interruption may finish a remote episode');
          episode!.finish(input.outcome, input.reason);
          await episode!.settled();
          await recording?.flush();
          value = frame();
          break;
        }
        case 'settled':
          await episode!.settled();
          await recording?.flush();
          value = frame();
          break;
        case 'appearance':
          value = episode!.setAppearance(message.payload as import('../theme-catalog').ThemeId);
          break;
        case 'dispose':
          episode!.finish('stopped', 'Client disposed');
          await episode!.settled();
          await recording?.flush();
          episode!.dispose();
          episode = undefined;
          recording = undefined;
          break;
        default:
          throw new Error(`Unknown host command: ${method}`);
      }
      send({ id, value });
    } catch (error) {
      send({ id, error: rpcError(error) });
    }
  };
  const close = async () => {
    closed = true;
    for (const call of pending.values()) call.reject(new Error('Host connection closed'));
    pending.clear();
    world?.dispose();
    if (episode) {
      episode.finish('stopped', 'Client disconnected');
      const stopped = episode;
      await stopped.settled().catch(() => {});
      await recording?.flush().catch(() => {});
      stopped.dispose();
    }
  };
  return { receive, close };
}
