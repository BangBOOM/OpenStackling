import { DATASET_FORMAT, EVALUATION_FORMAT, matchesFormat, type RecordFormat } from './format';
import { prepareEpisodeDirectory } from './episode-directory';
import { stat, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { EpisodeWriter, atomicJson, type EpisodeMetadata } from './storage';
import { type Provenance } from '../provenance';
import type { EpisodeResult } from '../episode-types';
import type { EpisodePlan } from '../plan';
import type { PacketSink } from './protocol';
import { actualConfig, digest, type Manifest as PolicyManifest } from '../policy/contract';
import { calibration } from '../../simulation/sensors/camera';
import { WHOLE_BODY_TEACHER_VERSION } from '../../simulation/control/teacher-policy';
export type EvaluationRecord = Omit<
  EpisodeMetadata,
  'kind' | 'schemaVersion' | 'files' | 'format' | 'counts'
> &
  typeof EVALUATION_FORMAT;
export type EpisodeRecord = EpisodeMetadata | EvaluationRecord;
export interface RunWriter {
  begin(): Promise<void>;
  finish(result: EpisodeResult, metrics: Record<string, number>): Promise<EpisodeRecord>;
  interrupt(reason: string): Promise<void>;
}
export interface ResultStore {
  readonly header: RecordFormat;
  create(
    root: string,
    plan: EpisodePlan,
    source: Provenance,
    policy?: PolicyManifest,
  ): { writer: RunWriter; sink?: PacketSink };
  read(root: string, id: string): Promise<EpisodeRecord>;
}
export const datasetStore: ResultStore = {
  header: DATASET_FORMAT,
  create(root, plan, source, policy) {
    const writer = new EpisodeWriter(
      root,
      plan.id,
      plan.config,
      source,
      policy,
      plan.resolvedScene,
    );
    return { writer, sink: writer };
  },
  async read(root, id) {
    const value = JSON.parse(
      await readFile(path.join(root, 'episodes', id, 'metadata.json'), 'utf8'),
    );
    if (!matchesFormat(value, DATASET_FORMAT)) throw new Error('Unsupported dataset schema');
    return value;
  },
};
export const evaluationStore: ResultStore = {
  header: EVALUATION_FORMAT,
  create(root, plan, source, policy) {
    return { writer: new ResultWriter(root, plan, source, policy) };
  },
  async read(root, id) {
    const value = JSON.parse(
      await readFile(path.join(root, 'episodes', id, 'result.json'), 'utf8'),
    );
    if (!matchesFormat(value, EVALUATION_FORMAT)) throw new Error('Unsupported evaluation schema');
    return value;
  },
};
export class ResultWriter implements RunWriter {
  readonly temporary: string;
  readonly destination: string;
  constructor(
    private root: string,
    private plan: EpisodePlan,
    private source: Provenance,
    private policy?: PolicyManifest,
  ) {
    this.temporary = path.join(root, 'episodes', `.${plan.id}.partial`);
    this.destination = path.join(root, 'episodes', plan.id);
  }
  async begin() {
    await prepareEpisodeDirectory(this.root, this.plan.id);
    await atomicJson(path.join(this.temporary, 'pending.json'), {
      ...this.plan,
      provenance: this.source,
      ...(this.policy ? { policy: this.policy } : {}),
    });
  }
  async finish(result: EpisodeResult, metrics: Record<string, number>): Promise<EvaluationRecord> {
    const { config, resolvedScene, appearance } = this.plan;
    const record: EvaluationRecord = {
      ...EVALUATION_FORMAT,
      config,
      resolvedScene,
      appearance,
      provenance: this.source,
      result,
      metrics,
      calibration: calibration(config.camera, config.environment),
      ...(this.policy
        ? { policy: { ...this.policy, configHash: await digest(actualConfig(config)) } }
        : {
            teacher: {
              id: 'whole-body',
              version: WHOLE_BODY_TEACHER_VERSION,
            },
          }),
    };
    await atomicJson(path.join(this.temporary, 'result.json'), record);
    await rename(this.temporary, this.destination);
    return record;
  }
  async interrupt(reason: string) {
    try {
      await stat(this.temporary);
      await atomicJson(path.join(this.temporary, 'interruption.json'), { reason });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
