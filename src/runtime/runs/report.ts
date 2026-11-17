import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalize } from 'json-canonicalize';
import { hash } from '../provenance';
import { datasetStore, evaluationStore } from '../recording/result-store';
import { validateRecord } from '../recording/record-validation';
import { summarizeRun, type CompletedEpisode } from './summary';
import { readManifest } from './manifest';
export async function readRun(root: string) {
  const manifest = await readManifest(root);
  const store = manifest.kind === 'evaluation' ? evaluationStore : datasetStore;
  const completed: Record<string, CompletedEpisode> = {};
  const records = [];
  for (const id of (await readdir(path.join(root, 'episodes'))).sort()) {
    if (id.startsWith('.')) continue;
    const plan = manifest.plan[Number(id)];
    if (!/^\d{6}$/.test(id) || !plan || plan.id !== id)
      throw new Error('Unexpected episode directory');
    const record = await store.read(root, id);
    await validateRecord(record, plan, manifest.sourceHash, manifest.policy);
    if (
      Object.hasOwn(manifest.completed, id) &&
      manifest.checksums[id] !== hash(canonicalize(record))
    )
      throw new Error('Committed result checksum mismatch');
    completed[id] = {
      seed: plan.config.run.seed,
      caseIndex: plan.caseIndex,
      taskKind: record.result.evaluation.kind,
      outcome: record.result.outcome,
      evaluation: record.result.evaluation,
    };
    records.push({ id, record });
  }
  if (Object.keys(manifest.completed).some((id) => !completed[id]))
    throw new Error('A committed episode is missing');
  return { manifest, completed, records };
}
export async function report(root: string) {
  const { manifest, completed } = await readRun(root);
  return {
    ...summarizeRun(manifest.plan, completed),
    status: manifest.status,
    totalPlanned: manifest.plan.length,
    totalCompleted: Object.keys(completed).length,
    interruptions: manifest.interruptions,
  };
}
