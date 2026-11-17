import { DATASET_FORMAT } from './format';
import { prepareEpisodeDirectory } from './episode-directory';
import { WHOLE_BODY_TEACHER_VERSION } from '../../simulation/control/teacher-policy';
import { resolveScene } from '../../simulation/scene';
import type { ResolvedObject } from '../../simulation/world/objects';
import { writeFile, readFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { digest, actualConfig, type Manifest } from '../policy/contract';
import type { Config } from '../config';
import { appearanceIdentity, type AppearanceIdentity } from '../appearance';
import { calibration } from '../../simulation/sensors/camera';
import type { EpisodeResult } from '../episode-types';
import type { PacketRow } from './protocol';
import { CONTROLLERS, PHASES, controllerEnum, phaseEnum, writeNpz, type NpyMember } from './npz';
import { DIAGNOSTIC_FIELDS, diagnosticShapes, diagnosticValues } from './diagnostics';
const gunzipAsync = promisify(gunzip);
import { hash, type Provenance } from '../provenance';
export async function atomicJson(file: string, value: unknown) {
  await writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  await rename(file + '.tmp', file);
}
export type EpisodeMetadata = typeof DATASET_FORMAT & {
  appearance: AppearanceIdentity;
  policy?: Manifest & { configHash: string };
  config: Config;
  provenance: Provenance;
  resolvedScene: ResolvedObject[];
  teacher?: { id: string; version: number };
  calibration: ReturnType<typeof calibration>;
  result: EpisodeResult;
  counts: { observations: number; actions: number; diagnostics: number };
  files: Record<string, string>;
  format: {
    diagnostics: typeof DIAGNOSTIC_FIELDS;
    npz: Record<string, { descr: string; shape: number[] }>;
    controllers: string[];
    phases: string[];
    video: {
      codec: string;
      framerate: number;
      keyframes: number;
      timestamps: string;
      bitrate: number;
    };
  };
  metrics: Record<string, number>;
};
export class EpisodeWriter {
  private frame = 0;
  private actionCount = 0;
  private diagnosticCount = 0;
  private files: Record<string, string> = {};
  private obsTick: number[] = [];
  private obsTime: number[] = [];
  private obsState: number[][] = [];
  private obsCamera: number[][] = [];
  private depthFrames: Uint8Array[] = [];
  private actTick: number[] = [];
  private actTime: number[] = [];
  private actExecuted: number[][] = [];
  private actController: number[] = [];
  private actLabelValid: number[] = [];
  private actContinuous: number[] = [];
  private actTeacher: number[][] = [];
  private teacherSeen = false;
  private diagTick: number[] = [];
  private diagTime: number[] = [];
  private diagTarget: number[][] = [];
  private diagnostics: Record<keyof typeof DIAGNOSTIC_FIELDS, number[]> = {
    actuators: [],
    fingers: [],
    contacts: [],
    tcp: [],
    blocks: [],
  };
  private diagState: number[][] = [];
  private diagPhase: number[] = [];
  private blocks: number | undefined;
  private video: Uint8Array | undefined;
  private videoCodec: string | undefined;
  writeMs = 0;
  readonly temporary: string;
  readonly destination: string;
  constructor(
    readonly root: string,
    readonly id: string,
    readonly config: Config,
    readonly source: Provenance,
    readonly policy?: Manifest,
    readonly resolvedScene: ResolvedObject[] = resolveScene(config),
  ) {
    this.temporary = path.join(root, 'episodes', `.${id}.partial`);
    this.destination = path.join(root, 'episodes', id);
  }
  async begin() {
    await prepareEpisodeDirectory(this.root, this.id);
    await atomicJson(path.join(this.temporary, 'pending.json'), {
      config: this.config,
      appearance: appearanceIdentity(this.config.appearance.theme),
      provenance: this.source,
      ...(this.policy ? { policy: this.policy } : {}),
    });
  }
  async append(rows: PacketRow[]) {
    const start = performance.now();
    for (const record of rows) {
      if (record.kind === 'observation') {
        const expected =
          (this.frame * this.config.environment.physicsHz) / this.config.run.observationHz;
        if (record.row.tick !== expected)
          throw new Error(`Observation tick ${record.row.tick}, expected ${expected}`);
        this.obsTick.push(record.row.tick);
        this.obsTime.push(record.row.time);
        this.obsState.push(record.row.state as number[]);
        {
          if (record.row.cameraToWorld?.length !== 16)
            throw new Error('Missing observation camera pose');
          // Three.js exposes column-major elements; NPZ matrices use row-major axes.
          this.obsCamera.push(
            Array.from(
              { length: 16 },
              (_, i) => record.row.cameraToWorld![(i % 4) * 4 + Math.floor(i / 4)],
            ),
          );
        }
        if (this.config.camera.depth !== Boolean(record.depth))
          throw new Error('Depth presence mismatch');
        if (record.depth) this.depthFrames.push(record.depth);
        this.frame++;
      } else if (record.kind === 'action') {
        if (
          record.row.tick !==
          (this.actionCount * this.config.environment.physicsHz) / this.config.run.controlHz
        )
          throw new Error('Action clock mismatch');
        if (record.row.teacher_action) this.teacherSeen = true;
        this.actTick.push(record.row.tick);
        this.actTime.push(record.row.time);
        this.actExecuted.push(record.row.executed_action as number[]);
        this.actController.push(controllerEnum(record.row.controller));
        this.actLabelValid.push(record.row.label_valid ? 1 : 0);
        this.actContinuous.push(record.row.continuous ? 1 : 0);
        this.actTeacher.push((record.row.teacher_action ?? record.row.executed_action) as number[]);
        this.actionCount++;
      } else if (record.kind === 'diagnostic') {
        const s = record.row.snapshot;
        const count = s.blocks.length;
        if (this.blocks === undefined) this.blocks = count;
        else if (this.blocks !== count) throw new Error('Block count changed mid-episode');
        this.diagTick.push(record.row.tick);
        this.diagTime.push(record.row.time);
        this.diagTarget.push(s.target as number[]);
        const values = diagnosticValues(s);
        for (const key of Object.keys(values) as (keyof typeof values)[])
          this.diagnostics[key].push(...values[key]);
        this.diagState.push(s.state as number[]);
        this.diagPhase.push(phaseEnum(record.row.phase));
        this.diagnosticCount++;
      } else {
        if (this.video) throw new Error('Duplicate video');
        this.video = record.data;
        this.videoCodec = record.codec;
      }
    }
    this.writeMs += performance.now() - start;
  }
  async interrupt(reason: string) {
    await atomicJson(path.join(this.temporary, 'interruption.json'), {
      reason,
      at: new Date().toISOString(),
    });
  }
  async finish(result: EpisodeResult, metrics: Record<string, number>) {
    const finishStart = performance.now();
    if (result.observations !== this.frame || result.actions !== this.actionCount)
      throw new Error('Episode count mismatch');
    if (!this.video) throw new Error('Missing video');
    const c = this.config,
      width = 16;
    const members: Record<string, NpyMember> = {
      'obs.tick': {
        descr: '<i8',
        shape: [this.frame],
        data: BigInt64Array.from(this.obsTick, (v) => BigInt(v)),
      },
      'obs.time': { descr: '<f8', shape: [this.frame], data: Float64Array.from(this.obsTime) },
      'obs.state': {
        descr: '<f8',
        shape: [this.frame, width],
        data: Float64Array.from(this.obsState.flat()),
      },
      'act.tick': {
        descr: '<i8',
        shape: [this.actionCount],
        data: BigInt64Array.from(this.actTick, (v) => BigInt(v)),
      },
      'act.time': {
        descr: '<f8',
        shape: [this.actionCount],
        data: Float64Array.from(this.actTime),
      },
      'act.executed': {
        descr: '<f8',
        shape: [this.actionCount, width],
        data: Float64Array.from(this.actExecuted.flat()),
      },
      'act.controller': {
        descr: '|u1',
        shape: [this.actionCount],
        data: Uint8Array.from(this.actController),
      },
      'act.label_valid': {
        descr: '|u1',
        shape: [this.actionCount],
        data: Uint8Array.from(this.actLabelValid),
      },
      'act.continuous': {
        descr: '|u1',
        shape: [this.actionCount],
        data: Uint8Array.from(this.actContinuous),
      },
      'diag.tick': {
        descr: '<i8',
        shape: [this.diagnosticCount],
        data: BigInt64Array.from(this.diagTick, (v) => BigInt(v)),
      },
      'diag.time': {
        descr: '<f8',
        shape: [this.diagnosticCount],
        data: Float64Array.from(this.diagTime),
      },
      'diag.target': {
        descr: '<f8',
        shape: [this.diagnosticCount, width],
        data: Float64Array.from(this.diagTarget.flat()),
      },
      'diag.state': {
        descr: '<f8',
        shape: [this.diagnosticCount, width],
        data: Float64Array.from(this.diagState.flat()),
      },
      'diag.phase': {
        descr: '|u1',
        shape: [this.diagnosticCount],
        data: Uint8Array.from(this.diagPhase),
      },
    };
    for (const [key, shape] of Object.entries(
      diagnosticShapes(this.diagnosticCount, this.blocks ?? 0),
    ))
      members[`diag.${key}`] = {
        descr: '<f8',
        shape,
        data: Float64Array.from(this.diagnostics[key as keyof typeof this.diagnostics]),
      };
    members['obs.camera_to_world'] = {
      descr: '<f8',
      shape: [this.frame, 4, 4],
      data: Float64Array.from(this.obsCamera.flat()),
    };
    if (this.teacherSeen)
      members['act.teacher_action'] = {
        descr: '<f8',
        shape: [this.actionCount, width],
        data: Float64Array.from(this.actTeacher.flat()),
      };
    if (c.camera.depth) {
      const { width, heightPixels } = c.camera;
      const depth = new Uint16Array(this.frame * width * heightPixels);
      for (let i = 0; i < this.depthFrames.length; i++) {
        const raw = await gunzipAsync(this.depthFrames[i]),
          frame = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
        if (frame.length !== width * heightPixels)
          throw new Error(`Invalid depth frame: ${frame.length} != ${width * heightPixels}`);
        depth.set(frame, i * width * heightPixels);
      }
      members['obs.depth'] = {
        descr: '<u2',
        shape: [this.frame, heightPixels, width],
        data: depth,
      };
    }
    const npz = await writeNpz(members);
    await writeFile(path.join(this.temporary, 'video.mp4'), this.video);
    await writeFile(path.join(this.temporary, 'data.npz'), npz);
    this.files['video.mp4'] = hash(this.video);
    this.files['data.npz'] = hash(npz);
    const metadata: EpisodeMetadata = {
      ...DATASET_FORMAT,
      resolvedScene: structuredClone(this.resolvedScene),
      ...(this.teacherSeen
        ? {
            teacher: {
              id: 'whole-body',
              version: WHOLE_BODY_TEACHER_VERSION,
            },
          }
        : {}),
      appearance: appearanceIdentity(this.config.appearance.theme),
      ...(this.policy
        ? { policy: { ...this.policy, configHash: await digest(actualConfig(this.config)) } }
        : {}),
      config: this.config,
      provenance: this.source,
      calibration: calibration(this.config.camera, this.config.environment),
      result,
      counts: {
        observations: this.frame,
        actions: this.actionCount,
        diagnostics: this.diagnosticCount,
      },
      files: this.files,
      format: {
        diagnostics: DIAGNOSTIC_FIELDS,
        npz: Object.fromEntries(
          Object.entries(members).map(([k, v]) => [k, { descr: v.descr, shape: v.shape }]),
        ),
        controllers: CONTROLLERS,
        phases: PHASES,
        video: {
          codec: this.videoCodec ?? 'unknown',
          framerate: c.run.observationHz,
          keyframes: c.run.observationHz,
          timestamps: 'tick*1e6/physicsHz',
          bitrate: Math.round(c.camera.width * c.camera.heightPixels * c.run.observationHz * 0.15),
        },
      },
      metrics: {
        ...metrics,
        writeMs: this.writeMs,
        finishMs: performance.now() - finishStart,
        videoBytes: this.video.length,
      },
    };
    await atomicJson(path.join(this.temporary, 'metadata.json'), metadata);
    await rename(this.temporary, this.destination);
    return metadata;
  }
}

export async function acquireDatasetLock(root: string) {
  const file = path.join(root, '.collector.lock');
  try {
    const previous = Number(await readFile(file, 'utf8'));
    if (!Number.isSafeInteger(previous) || previous < 1) throw new Error('Invalid dataset lock');
    try {
      process.kill(previous, 0);
      throw new Error(`Dataset is in use by process ${previous}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
    await unlink(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const handle = await open(file, 'wx');
  await handle.writeFile(String(process.pid));
  await handle.close();
  return () => unlink(file);
}
