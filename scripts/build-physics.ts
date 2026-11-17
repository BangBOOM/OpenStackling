import { mkdir, copyFile, writeFile, readFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { physicsSourceHash, type PhysicsBuild } from '../src/simulation/world/physics-build';
const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, '.tmp/physics/target');
const run = promisify(execFile);
const { stdout, stderr } = await run(
  'cargo',
  ['build', '--release', '--locked', '-p', 'stackling-physics'],
  {
    cwd: root,
    env: { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS: '-C target-cpu=native' },
    maxBuffer: 8 * 1024 * 1024,
  },
);
process.stderr.write(stdout + stderr);
const library =
  process.platform === 'darwin'
    ? 'libstackling_physics.dylib'
    : process.platform === 'win32'
      ? 'stackling_physics.dll'
      : 'libstackling_physics.so';
await mkdir(path.join(root, '.tmp/physics'), { recursive: true });
const temporarySuffix = `.${process.pid}.tmp`;
const binary = path.join(root, '.tmp/physics/stackling_physics.node');
await copyFile(path.join(target, 'release', library), binary + temporarySuffix);
await rename(binary + temporarySuffix, binary);
const build: PhysicsBuild = {
  schemaVersion: 1,
  sourceHash: physicsSourceHash(root),
  binarySha256: createHash('sha256')
    .update(await readFile(binary))
    .digest('hex'),
  rustc: (await run('rustc', ['-vV'])).stdout.trim(),
  rustflags: '-C target-cpu=native',
  platform: process.platform,
  arch: process.arch,
};
const manifest = path.join(root, '.tmp/physics/build.json');
await writeFile(manifest + temporarySuffix, JSON.stringify(build, null, 2) + '\n');
await rename(manifest + temporarySuffix, manifest);
