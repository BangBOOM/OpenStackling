import { canonicalize } from 'json-canonicalize';
import { validateConfig } from '../config';
import { finiteTree } from '../../simulation/validation';
import { resolveTask } from '../../simulation/tasks/registry';
import {
  actualConfig,
  digest,
  validateProfile,
  profileConfig,
  PROTOCOL,
  type Manifest as PolicyManifest,
} from '../policy/contract';
import type { EpisodeRecord } from './result-store';
import type { EpisodePlan } from '../plan';
export async function validateRecord(
  record: EpisodeRecord,
  plan: EpisodePlan,
  sourceHash: string,
  policy?: PolicyManifest,
) {
  validateConfig(record.config);
  finiteTree(record.result);
  if (
    record.provenance.sourceHash !== sourceHash ||
    canonicalize(record.config) !== canonicalize(plan.config) ||
    canonicalize(record.appearance) !== canonicalize(plan.appearance)
  )
    throw new Error('Committed episode provenance mismatch');
  if (canonicalize(record.resolvedScene) !== canonicalize(plan.resolvedScene))
    throw new Error('Resolved scene metadata mismatch');
  if (
    canonicalize(record.result.task) !== canonicalize(resolveTask(record.config)) ||
    canonicalize(record.result.task) !== canonicalize(plan.task)
  )
    throw new Error('Task prompt/rules metadata mismatch');
  if (
    record.result.evaluation.kind !== record.config.task.kind ||
    !['success', 'timeout', 'completed', 'teacher-failed', 'stopped'].includes(
      record.result.outcome,
    ) ||
    !Number.isInteger(record.result.ticks) ||
    record.result.ticks < 0 ||
    record.result.seconds < 0 ||
    typeof record.result.reason !== 'string' ||
    !Number.isFinite(record.result.evaluation.heightMeters)
  )
    throw new Error('Invalid episode result');
  if (!policy && record.policy) throw new Error('Committed policy identity mismatch');
  if (policy) {
    if (!record.policy) throw new Error('Committed policy identity mismatch');
    const { configHash: _hash, ...identity } = record.policy;
    if (canonicalize(identity) !== canonicalize(policy))
      throw new Error('Committed policy identity mismatch');
  }
  if (record.policy) {
    const identity = record.policy;
    validateProfile(identity.profile);
    if (
      identity.protocol !== PROTOCOL ||
      !identity.policyId ||
      !identity.modelRevision ||
      (await digest(identity.profile)) !== identity.profileHash
    )
      throw new Error('Policy identity/profile hash mismatch');
    if (canonicalize(profileConfig(record.config)) !== canonicalize(identity.profile.config))
      throw new Error('Policy runtime configuration mismatch');
  }
  if (
    record.policy &&
    record.policy.configHash !== (await digest(actualConfig(record.config, record.appearance)))
  )
    throw new Error('Policy actual configuration mismatch');
}
