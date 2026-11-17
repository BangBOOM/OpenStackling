import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Generated reports stay local and must never be committed.
export async function reportPath(name: string, override?: string) {
  const file = override ?? path.join('.tmp', 'reports', name);
  await mkdir(path.dirname(file), { recursive: true });
  return file;
}
