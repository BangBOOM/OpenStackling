import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SceneRequest } from '../../simulation/scene';
import type { AppearanceIdentity } from '../appearance';
import type { Config } from '../config';
import type { EpisodePlan } from '../plan';
import type { Manifest as PolicyManifest } from '../policy/contract';
import {
  DATASET_FORMAT,
  EVALUATION_FORMAT,
  matchesFormat,
  type RecordFormat,
} from '../recording/format';
import type { CompletedEpisode } from './summary';

export type RunManifest = RecordFormat & {
  appearance: AppearanceIdentity;
  identity: string;
  config: Config;
  sourceHash: string;
  seeds: number[];
  plan: EpisodePlan[];
  sceneGeneration?: SceneRequest;
  positions: string[];
  checksums: Record<string, string>;
  completed: Record<string, CompletedEpisode>;
  status: string;
  browserVersion: string;
  interruptions: number;
  policy?: PolicyManifest;
};

export async function readManifest(root: string, expected?: RecordFormat): Promise<RunManifest> {
  const manifest: RunManifest = JSON.parse(
    await readFile(path.join(root, 'manifest.json'), 'utf8'),
  );
  const format = expected ?? (manifest.kind === 'evaluation' ? EVALUATION_FORMAT : DATASET_FORMAT);
  if (!matchesFormat(manifest, format)) throw new Error('Run mode/schema mismatch');
  const { completed, checksums } = manifest;
  if (
    !checksums ||
    typeof checksums !== 'object' ||
    Array.isArray(checksums) ||
    Object.keys(checksums).length !== Object.keys(completed).length ||
    Object.keys(completed).some(
      (id) => typeof checksums[id] !== 'string' || !/^[a-f0-9]{64}$/.test(checksums[id]),
    )
  )
    throw new Error('Missing or invalid committed episode checksum');
  return manifest;
}
