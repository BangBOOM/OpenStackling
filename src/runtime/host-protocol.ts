import type { Config } from './config';
import type { ResolvedEpisode } from './plan';
import type { EpisodeResult } from './episode-types';
import type { TaskEvaluation, ResolvedTask } from '../simulation/tasks/types';
import type { MeasuredFrame, WorldMetadata } from '../simulation/world/frame';

export const HOST_PROTOCOL_VERSION = 4;
export const SINK_METHODS = ['observation', 'action', 'diagnostic'] as const;
export type EpisodeFrame = {
  physics: MeasuredFrame;
  phase: string;
  stage: 'active' | 'validating' | 'finished';
  result: EpisodeResult | null;
  observations: number;
  actions: number;
  score: {
    task: ResolvedTask;
    evaluation: TaskEvaluation;
    stableSeconds: number;
    success: boolean;
  };
  teacher?: {
    phase: string;
    reason: string;
    decisions: import('../simulation/control/teachers/whole-body-types').TeacherDecision[];
  };
};
export type OpenEpisode = {
  config: Config;
  plan: ResolvedEpisode;
  source: 'teacher' | 'manual' | 'client';
  name: string;
  sink: (typeof SINK_METHODS)[number][];
  recording?: string;
  version: number;
};
export type EpisodeOpened = { metadata: WorldMetadata; frame: EpisodeFrame };
export type RpcError = { message: string; code?: string; detail?: string };
export function rpcError(value: unknown): RpcError {
  if (!(value instanceof Error)) return { message: String(value) };
  const error = value as Error & { code?: string; detail?: string };
  return {
    message: error.message,
    ...(typeof error.code === 'string' && { code: error.code }),
    ...(typeof error.detail === 'string' && { detail: error.detail }),
  };
}
export type RpcMessage =
  | { id: number; method: string; payload: unknown }
  | { id: number; value?: unknown; error?: RpcError };
