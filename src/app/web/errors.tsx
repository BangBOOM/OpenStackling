import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

// Adapt diagnostic messages at the UI boundary; keep the original message in runtime state.
const errors: Record<string, string> = {
  'Non-finite configuration': 'nonFinite',
  'Cannot connect to episode host': 'runtimeHost',
  'Runtime connection closed': 'runtimeHost',
  'Episode worker failed': 'runtimeHost',
  'Episode worker exited': 'runtimeHost',
  'Physics artifact is stale. Run bun run build:physics.': 'physicsBuild',
  'Rates must divide physicsHz': 'rates',
  'Seed must be uint32': 'seed',
  'Unsupported tower height': 'blocks',
  'Completion tasks require cubes': 'taskInventory',
  'Partition tasks require equal cubes': 'taskInventory',
  'Tower counts must use every object': 'taskCounts',
  'Lost grasp': 'slip',
  'No collision-free whole-body grasp': 'unreachable',
  'No remaining partition placement candidates': 'stackUnreachable',
  'No safe transport after contact': 'unreachable',
  'No collision-free retreat': 'unreachable',
  'Could not establish a bilateral grasp': 'graspContact',
  'Action must contain sixteen finite, in-range absolute targets': 'bodyAction',
  'Cuboid size requires three dimensions': 'taskInventory',
  'Invalid sampling region': 'region',
  'Camera resolution exceeds 4096': 'resolution',
  'Invalid camera': 'camera',
  'Invalid camera mount': 'camera',
  'Invalid head camera': 'headCamera',
  'Layout generation exhausted maxAttempts': 'layout',
  'Negative friction': 'friction',
  'Invalid robot dimensions': 'config',
  'Unsupported link geometry': 'config',
  'Invalid motor count or home gap': 'config',
  'Joint axis must be unit length': 'config',
  'Invalid joint limits/home': 'config',
  'episode time limit': 'timeout',
};
export function errorMessage(value: string, t: TFunction) {
  const message = value.replace(/^Error: /, '');
  const policyCode = message.replace(/^PolicyError: /, '').split(':')[0];
  if (t(`policy.errors.${policyCode}`, { defaultValue: '' }))
    return t(`policy.errors.${policyCode}`);
  if (errors[message]) return t(`error.${errors[message]}`);
  if (message.startsWith('Unknown theme: '))
    return t('error.unknownTheme', { theme: message.slice(15) });
  if (message.startsWith('Invalid ')) {
    const field = message.slice(8);
    return t('error.positive', { field: t(`field.${field}`, { defaultValue: field }) });
  }
  if (message.startsWith('Unknown configuration key: '))
    return t('error.unknownKey', { field: message.slice(27) });
  if (message.endsWith(' timed out')) {
    const phase = t(`phase.${message.slice(0, -10)}`, { defaultValue: '' });
    if (phase) return t('error.phaseTimeout', { phase });
  }
  return t('error.unexpected');
}
export function ErrorText({ value }: { value: string }) {
  const { t } = useTranslation();
  const text = errorMessage(value, t);
  const unexpected = text === t('error.unexpected');
  useEffect(() => {
    if (unexpected) console.error(value);
  }, [value, unexpected]);
  return <>{text}</>;
}
