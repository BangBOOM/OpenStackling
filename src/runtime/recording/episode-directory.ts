import { mkdir, stat, rename } from 'node:fs/promises';
import path from 'node:path';
export async function prepareEpisodeDirectory(root: string, id: string) {
  const destination = path.join(root, 'episodes', id),
    temporary = path.join(root, 'episodes', `.${id}.partial`);
  try {
    await stat(destination);
    throw new Error(`Episode already exists: ${id}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  try {
    await stat(temporary);
    await mkdir(path.join(root, 'interrupted'), { recursive: true });
    await rename(temporary, path.join(root, 'interrupted', `${id}-${Date.now()}`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await mkdir(temporary, { recursive: true });
}
