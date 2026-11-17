import type { Config } from '../config';
import type { SceneRequest } from '../../simulation/scene';
import type { BrowserHost } from './browser-host';
import type { Page } from 'playwright';
import type { Manifest as PolicyManifest } from '../policy/contract';
import type { EpisodeResult } from '../episode-types';
import type { EpisodePlan } from '../plan';
import type { PacketSink } from '../recording/protocol';
export type RunOptions = {
  out: string;
  seeds: number[];
  workers: number;
  cases?: Config[];
  sceneGeneration?: SceneRequest;
  resume?: boolean;
  positions?: string[];
  visible?: boolean;
  signal?: AbortSignal;
  progress?(
    total: number,
    completed: number,
    successes: number,
    label: string,
  ): {
    event(message: string): void;
    episode(success: boolean): void;
    worker(delta: number): void;
    stop(): void;
  };
  policy?: { manifest: PolicyManifest; host: BrowserHost; page: Page };
};
export type Execution = { result: EpisodeResult; metrics: Record<string, number> };
export interface WorkerExecutor {
  run(plan: EpisodePlan, sink?: PacketSink): Promise<Execution>;
  retry(error: unknown): Promise<boolean>;
}
export interface RunExecutor {
  readonly browserVersion: string;
  start(workers: number): Promise<void>;
  worker(index: number): Promise<WorkerExecutor>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
