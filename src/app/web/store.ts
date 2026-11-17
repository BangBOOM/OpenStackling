import { create } from 'zustand';
import { resolveConfig, type Config } from '../../runtime/config';
export const TEACHER_RATES = [1, 2, 5] as const;
export type TeacherRate = (typeof TEACHER_RATES)[number];
export type Viewport = 'orbit' | 'head';
export const DEFAULT_DISPLAY = {
  markers: false,
  annotations: false,
  viewport: 'orbit' as Viewport,
};
export type Mode = 'loading' | 'idle' | 'editing' | 'running' | 'paused' | 'finished' | 'resetting';
// Shared by command handlers and controls. Visibility is derived from mode.
export type PolicyStatus =
  | 'disconnected'
  | 'connecting'
  | 'review'
  | 'binding'
  | 'bound'
  | 'draining'
  | 'fault';
export function permissions(mode: Mode, teacher: boolean, policy: PolicyStatus = 'disconnected') {
  const active = mode === 'running' || mode === 'paused',
    canStart = mode === 'idle' || mode === 'finished';
  return {
    view: mode !== 'loading' && mode !== 'resetting',
    viewSettings: mode !== 'loading' && mode !== 'resetting',
    edit: canStart && (policy === 'disconnected' || policy === 'bound'),
    play: (canStart || active) && (policy === 'disconnected' || policy === 'bound'),
    teacher: (canStart || (active && teacher)) && policy === 'disconnected',
    rate: (canStart || (active && teacher)) && policy === 'disconnected',
    reset:
      policy === 'bound'
        ? mode === 'paused' || mode === 'finished'
        : (canStart || active) && policy === 'disconnected',
    shuffle: canStart && (policy === 'disconnected' || policy === 'bound'),
    theme: canStart && (policy === 'disconnected' || policy === 'bound'),
    manual: (mode === 'idle' || mode === 'running') && !teacher && policy === 'disconnected',
  };
}
export type Telemetry = {
  teacher: boolean;
  time: number;
  status: string;
  phase: string;
  stacked: number;
  heightMeters: number;
  heightTask: boolean;
  total: number;
  state: number[];
  target: number[];
};
export const useUI = create<{
  policyStatus: PolicyStatus;
  policyOpen: boolean;
  settingsViewOpen: boolean;
  sceneSeed: number | null;
  draftSceneSeed: number | null;
  policyManifest: import('../../runtime/policy/contract').Manifest | null;
  policyDiff: { path: string; before: unknown; after: unknown }[];
  mode: Mode;
  teacherRate: TeacherRate;
  previewOpen: boolean;
  shortcutsOpen: boolean;
  viewport: Viewport;
  annotations: boolean;
  markers: boolean;
  config: Config;
  draft: Config | null;
  previewConfig: Config;
  draftError: string;
  telemetry: Telemetry;
  error: string;
}>(() => ({
  policyStatus: 'disconnected',
  policyOpen: false,
  settingsViewOpen: false,
  sceneSeed: null,
  draftSceneSeed: null,
  policyManifest: null,
  policyDiff: [],
  mode: 'loading',
  teacherRate: 1,
  previewOpen: true,
  shortcutsOpen: false,
  ...DEFAULT_DISPLAY,
  config: resolveConfig(),
  draft: null,
  previewConfig: resolveConfig(),
  draftError: '',
  error: '',
  telemetry: {
    teacher: false,
    time: 0,
    status: 'loading',
    phase: 'manual',
    stacked: 0,
    heightMeters: 0,
    heightTask: false,
    total: 0,
    state: [],
    target: [],
  },
}));
