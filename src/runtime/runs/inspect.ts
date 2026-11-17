import { inspectEpisode } from '../recording/inspect';
import { readRun } from './report';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
export async function inspect(root: string) {
  try {
    await readFile(path.join(root, 'result.json'));
    const { records } = await readRun(path.resolve(root, '../..'));
    return records
      .filter((row) => row.id === path.basename(root))
      .map(({ id, record }) => ({
        episode: id,
        outcome: record.result.outcome,
        observations: record.result.observations,
        actions: record.result.actions,
        seconds: record.result.seconds,
      }));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  try {
    await readFile(path.join(root, 'metadata.json'));
    return [await inspectEpisode(root)];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const { manifest, records } = await readRun(root);
  if (manifest.kind === 'evaluation') {
    return records.map(({ id, record }) => ({
      episode: id,
      outcome: record.result.outcome,
      observations: record.result.observations,
      actions: record.result.actions,
      seconds: record.result.seconds,
    }));
  }
  const rows = [];
  for (const { id } of records) rows.push(await inspectEpisode(path.join(root, 'episodes', id)));
  return rows;
}
