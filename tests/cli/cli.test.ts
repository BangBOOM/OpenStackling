import { resolveConfig } from '../../src/runtime/config';
import { generatedObjects } from '../../src/simulation/scene';
import { cubeObjects } from '../../src/simulation/world/objects';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserHost } from '../../src/runtime/runs/browser-host';

test(
  'CLI height collection generates per-seed inventories and resumes without a suite',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stackling-height-cli-'));
    const out = path.join(dir, 'random');
    const args = [
      'src/app/cli/main.ts',
      'collect',
      '--task-preset',
      'max-height',
      '--blocks',
      '8',
      '--seed',
      '0',
      '--episodes',
      '2',
      '--seconds',
      '0.2',
      '--width',
      '64',
      '--height',
      '48',
      '--out',
      out,
    ];
    const run = (extra: string[] = []) => {
      const result = spawnSync(process.execPath, [...args, ...extra], {
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    try {
      assert.equal(run().totalCompleted, 2);
      const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.sceneGeneration, { kind: 'random-mixed', version: 2, count: 8 });
      for (const entry of manifest.plan)
        assert.deepEqual(
          entry.config.scene.objects,
          generatedObjects(
            { kind: 'random-mixed', version: 2, count: 8 },
            entry.config.run.seed,
            0.3,
          ),
        );
      const metadataPath = path.join(out, 'episodes/000000/metadata.json');
      const before = await readFile(metadataPath, 'utf8');
      assert.equal(run(['--resume']).completedThisRun, 0);
      assert.equal(await readFile(metadataPath, 'utf8'), before);
      // An explicit size still selects fixed equal cubes across the seed plan.
      const fixed = path.join(dir, 'fixed');
      assert.equal(run(['--size', '0.06', '--out', fixed]).totalCompleted, 2);
      const fixedManifest = JSON.parse(await readFile(path.join(fixed, 'manifest.json'), 'utf8'));
      assert.equal(fixedManifest.sceneGeneration, undefined);
      for (const entry of fixedManifest.plan)
        assert.deepEqual(entry.config.scene.objects, cubeObjects(8, 0.06));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'CLI overrides reach the physical runner and browser without default fallback',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stackling-cli-'));
    const file = path.join(dir, 'config.json');
    const args = ['src/app/cli/main.ts'];
    const host = new BrowserHost();
    let server: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    try {
      await writeFile(
        file,
        JSON.stringify({ scene: { objects: cubeObjects(7) }, run: { observationHz: 7 } }),
      );
      const overrides = [
        '--config',
        file,
        '--blocks',
        '2',
        '--observation-hz',
        '10',
        '--seed',
        '2026',
        '--camera',
        'NW',
        '--theme',
        'studio',
      ];
      const teacher = spawnSync(
        process.execPath,
        [...args, 'teacher', ...overrides, '--seconds', '0.01'],
        { encoding: 'utf8', timeout: 15000 },
      );
      assert.equal(teacher.status, 0, teacher.stderr);
      const [result] = JSON.parse(teacher.stdout);
      assert.equal(result.seed, 2026);
      assert.equal(result.outcome, 'timeout');
      const invalid = spawnSync(process.execPath, [...args, 'teacher', '--config', file], {
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /Rates must divide physicsHz/);
      const defaultProfile = path.join(dir, 'default-blocks.json');
      const blocks = spawnSync(
        process.execPath,
        [...args, 'policy-profile', '--blocks', '3', '--out', defaultProfile],
        { encoding: 'utf8', timeout: 15000 },
      );
      assert.equal(blocks.status, 0, blocks.stderr);
      const inventory = JSON.parse(await readFile(defaultProfile, 'utf8')).trainingTasks[0].scene
        .objects;
      assert.deepEqual(
        inventory.map((object: { shape: unknown }) => object.shape),
        Array(3).fill(resolveConfig().scene.objects[0].shape),
      );
      for (const preset of ['max-height', 'stack-sized', 'stack-ordered']) {
        const out = path.join(dir, `${preset}.json`);
        const exported = spawnSync(
          process.execPath,
          [
            ...args,
            'policy-profile',
            '--task-preset',
            preset,
            '--blocks',
            '5',
            '--seed',
            '2026',
            '--out',
            out,
          ],
          { encoding: 'utf8', timeout: 15000 },
        );
        assert.equal(exported.status, 0, exported.stderr);
        const profile = JSON.parse(await readFile(out, 'utf8'));
        assert.deepEqual(
          profile.trainingTasks[0].scene.objects,
          generatedObjects(
            {
              kind: preset === 'max-height' ? 'random-mixed' : 'random-sized',
              version: 2,
              count: 5,
            },
            2026,
            0.3,
          ),
        );
      }

      server = spawn(process.execPath, [...args, 'world', ...overrides, '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      closed = once(server, 'close');
      const url = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('CLI world startup timed out')), 15000);
        let output = '';
        server!.stdout!.on('data', (chunk) => {
          output += String(chunk);
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
          if (match) {
            clearTimeout(timeout);
            resolve(match[0]);
          }
        });
        server!.stderr!.on('data', (chunk) => {
          output += String(chunk);
        });
        server!.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        server!.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`CLI exited ${code}: ${output}`));
        });
      });
      await host.start();
      const page = await host.newPage();
      await page.goto(url);
      await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
      const config = await page.evaluate(() => (window as any).stacklingUI.config);
      assert.equal(config.run.seed, 2026);
      assert.equal(config.run.observationHz, 10);
      assert.equal(config.scene.objects.length, 2);
      assert.equal(config.camera.position, 'NW');
      assert.equal(config.appearance.theme, 'studio');
      assert.equal(config.run.maxSeconds, 120);
    } finally {
      if (server) {
        server.kill('SIGTERM');
        await closed;
      }
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'CLI result-only evaluation, reporting and resume use the same generated seed plan',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stackling-evaluate-cli-'));
    const out = path.join(root, 'run');
    const args = [
      'src/app/cli/main.ts',
      'evaluate',
      '--task-preset',
      'max-height',
      '--blocks',
      '8',
      '--seed',
      '0',
      '--episodes',
      '2',
      '--seconds',
      '0.2',
      '--out',
      out,
    ];
    try {
      const first = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
      assert.equal(first.status, 0, first.stderr);
      assert.equal(JSON.parse(first.stdout).totalCompleted, 2);
      const before = await readFile(path.join(out, 'episodes/000000/result.json'), 'utf8');
      const resumed = spawnSync(process.execPath, [...args, '--resume'], {
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).completedThisRun, 0);
      assert.equal(await readFile(path.join(out, 'episodes/000000/result.json'), 'utf8'), before);
      const report = spawnSync(process.execPath, ['src/app/cli/main.ts', 'report', out], {
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(report.status, 0, report.stderr);
      assert.equal(JSON.parse(report.stdout).byTask['max-height'].heightMeters.count, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'browser hosts drain a cold dependency crawl before closing without a page',
  { timeout: 60000 },
  () => {
    const script = `
    import { BrowserHost } from './src/runtime/runs/browser-host';
    for (let i = 0; i < 3; i++) {
      const host = new BrowserHost();
      await host.start();
      await host.close();
    }
    console.log('closed');
  `;
    const result = spawnSync(process.execPath, ['--eval', script], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'closed');
  },
);
