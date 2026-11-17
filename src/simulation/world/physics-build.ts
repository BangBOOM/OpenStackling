import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export type PhysicsBuild = {
  schemaVersion: 1;
  sourceHash: string;
  binarySha256: string;
  rustc: string;
  rustflags: string;
  platform: string;
  arch: string;
};
export function physicsSourceHash(root: string) {
  const files = ['Cargo.toml', 'Cargo.lock'];
  function walk(dir: string) {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'target') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else files.push(file);
    }
  }
  walk('physics');
  const hash = createHash('sha256');
  for (const file of files.sort())
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(path.join(root, file)));
  return hash.digest('hex');
}
