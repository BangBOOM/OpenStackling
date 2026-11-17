import type { PhysicsBuild } from '../simulation/world/physics-build.js';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import path from 'node:path';
export async function environmentFingerprint(root = process.cwd()) {
  const file = (relative: string) => path.join(root, relative);
  const names = (await readdir(file('src/simulation/world')))
    .filter((n) => n.endsWith('.ts') && n !== 'random.ts')
    .map((n) => `src/simulation/world/${n}`);
  names.push(
    ...(await readdir(file('src/runtime/browser/render')))
      .filter((n) => n.endsWith('.ts') && n !== 'themes.ts')
      .map((n) => `src/runtime/browser/render/${n}`),
  );
  names.push(
    'configs/robot.json',
    'Cargo.toml',
    'Cargo.lock',
    'src/simulation/sensors/config.ts',
    'src/simulation/sensors/camera.ts',
    'src/runtime/episode-types.ts',
    'src/runtime/host-protocol.ts',
    'src/runtime/host-wire.ts',
    'src/runtime/host/server.ts',
    'src/runtime/host/session.ts',
    'src/runtime/host/worker.ts',
    'src/runtime/host/episode-host.ts',
    'src/runtime/client/episode-client.ts',
    'src/runtime/client/rpc.ts',
    'src/runtime/client/world-client.ts',
    'src/simulation/validation.ts',
    'src/runtime/episode.ts',
    'src/runtime/browser/encoder.ts',
    'src/runtime/browser/encode-worker.ts',
    'src/runtime/browser/frame-pipeline.ts',
  );
  async function physicsSources(dir: string) {
    for (const entry of await readdir(file(dir), { withFileTypes: true })) {
      if (entry.name === 'target') continue;
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await physicsSources(name);
      else names.push(name);
    }
  }
  await physicsSources('physics');
  const files = Object.fromEntries(
    await Promise.all(
      names.sort().map(async (n) => [
        n,
        createHash('sha256')
          .update(await readFile(file(n)))
          .digest('hex'),
      ]),
    ),
  );
  const defaults = JSON.parse(await readFile(file('configs/default.json'), 'utf8'));
  const runtimeDefaults = {
    environment: defaults.environment,
    camera: defaults.camera,
    run: { controlHz: defaults.run.controlHz, observationHz: defaults.run.observationHz },
  };
  const dependencies = Object.fromEntries(
    await Promise.all(
      ['three', 'fflate'].map(async (n) => [
        n,
        JSON.parse(await readFile(file(`node_modules/${n}/package.json`), 'utf8'))
          .version as string,
      ]),
    ),
  );
  const physicsBuild = JSON.parse(await readFile(file('.tmp/physics/build.json'), 'utf8'));
  return createHash('sha256')
    .update(canonicalize({ files, runtimeDefaults, dependencies, physicsBuild }))
    .digest('hex');
}

export const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export function runtimeId(): string {
  const versions = process.versions as Record<string, string | undefined>;
  return versions.bun ? `bun ${versions.bun}` : `node ${process.version}`;
}
export async function provenance(root = process.cwd()) {
  const physicsBuild = JSON.parse(
    await readFile(path.join(root, '.tmp/physics/build.json'), 'utf8'),
  ) as PhysicsBuild;
  const files: Record<string, string> = {};
  async function walk(dir: string) {
    for (const entry of (await readdir(path.join(root, dir), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const rel = path.join(dir, entry.name);
      if (entry.name === '__pycache__') continue;
      if (entry.isDirectory()) await walk(rel);
      else files[rel] = hash(await readFile(path.join(root, rel)));
    }
  }
  await walk('src');
  await walk('configs');
  await walk('protocol');
  await walk('physics');
  await walk('scripts');
  await walk('policy/src');
  for (const name of [
    'policy/uv.lock',
    'policy/pyproject.toml',
    'Cargo.toml',
    'Cargo.lock',
    'package.json',
    'bun.lock',
    'vite.config.ts',
    'tsconfig.json',
    'index.html',
    'worker.html',
  ])
    files[name] = hash(await readFile(path.join(root, name)));
  return {
    environmentFingerprint: await environmentFingerprint(root),
    sourceHash: hash(JSON.stringify({ files, physicsBuild })),
    physics: physicsBuild,
    files,
    node: process.version,
    runtime: runtimeId(),
    platform: process.platform,
    arch: process.arch,
  };
}
export type Provenance = Awaited<ReturnType<typeof provenance>> & { browserVersion?: string };
