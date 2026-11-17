import { reportPath } from './report-path';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
import { environmentFingerprint } from '../../src/runtime/provenance';
import { resolveConfig, type Config } from '../../src/runtime/config';
import { digest, makeProfile, type Manifest } from '../../src/runtime/policy/contract';
import { readNpz } from '../../src/runtime/recording/npz';
import { collect } from '../../src/runtime/runs/collect';
import { evaluate } from '../../src/runtime/runs/evaluate';
import { report } from '../../src/runtime/runs/report';
import { inspect } from '../../src/runtime/runs/inspect';
import { EpisodeWriter } from '../../src/runtime/recording/storage';
import { provenance } from '../../src/runtime/provenance';
import { appearanceIdentity } from '../../src/runtime/appearance';
import { THEME_IDS } from '../../src/runtime/theme-catalog';
import { replay } from '../../src/runtime/recording/replay';
import { generatedObjects } from '../../src/simulation/scene';
import type { Page } from 'playwright';
const root = path.resolve('.tmp', `policy-test-${Date.now()}`);
await mkdir(root, { recursive: true });
const fingerprint = await environmentFingerprint();
const passed: string[] = [];
const children = new Set<ChildProcess>();
async function server(
  config: Config,
  mode = 'normal',
  revision = 'probe-v1',
  token = '',
  cases: Config[] = [config],
) {
  const file = path.join(root, `profile-${children.size}.json`);
  await writeFile(file, JSON.stringify(makeProfile(config, fingerprint, 'acceptance', cases)));
  const child = spawn(
    'uv',
    [
      'run',
      '--project',
      'policy',
      'stackling-policy',
      'serve',
      '--profile',
      file,
      '--factory',
      'support:create',
      '--policy-id',
      'probe',
      '--model-revision',
      revision,
      '--port',
      '0',
    ],
    {
      env: {
        ...process.env,
        PYTHONPATH: path.resolve('policy/tests'),
        POLICY_TEST_MODE: mode,
        POLICY_TEST_TRACE: ['capture', 'head-motion'].includes(mode)
          ? path.join(root, mode + '-trace.jsonl')
          : '',
        STACKLING_POLICY_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  const closed = once(child, 'close');
  const url = await new Promise<string>((resolve, reject) => {
    let logs = '';
    const timer = setTimeout(() => reject(new Error(`Server startup: ${logs}`)), 15000);
    child.stderr!.on('data', (chunk) => {
      logs += chunk;
      const match = logs.match(/Uvicorn running on http:\/\/127.0.0.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`ws://127.0.0.1:${match[1]}/policy`);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(logs));
    });
    child.once('error', reject);
  });
  return {
    url,
    async close() {
      child.kill('SIGTERM');
      await closed;
      children.delete(child);
    },
  };
}
async function connect(
  page: Page,
  url: string,
  token = '',
  timeoutMs = 30000,
  initializationTimeoutMs = 120000,
) {
  return page.evaluate(async (options) => (window as any).stackling.connectPolicy(options), {
    url,
    token,
    timeoutMs,
    initializationTimeoutMs,
  }) as Promise<Manifest>;
}
async function bind(page: Page, config: Config) {
  await page.evaluate(async (c) => (window as any).stackling.bindPolicy(c), config);
}
async function cli(args: string[]) {
  const child = spawn(process.execPath, ['src/app/cli/main.ts', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b;
  });
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}
const host = new BrowserHost();
try {
  for (const [observationHz, controlHz, depth] of [
    [20, 10, false],
    [10, 10, true],
    [5, 20, false],
  ] as const) {
    const c = resolveConfig({
      camera: { width: 64, heightPixels: 48, depth },
      run: { maxSeconds: 0.4, observationHz, controlHz },
    });
    const svc = await server(c);
    const collector = new BrowserHost();
    await collector.start();
    const worker = await collector.newPage();
    const m = await connect(worker, svc.url);
    await bind(worker, c);
    const manifest = m;
    const extra = await collector.newPage();
    await assert.rejects(connect(extra, svc.url), /SERVER_BUSY/);
    await extra.close();
    const out = path.join(root, `rates-${observationHz}-${controlHz}`);
    const result = await collect(c, {
      out,
      seeds: [42, 2026],
      workers: 1,
      policy: { manifest: m, host: collector, page: worker },
    });
    assert.equal(result.successesThisRun, 0);
    const inspected = await inspect(out);
    assert.equal(inspected.length, 2);
    for (const row of inspected) {
      assert.equal(row.observations, Math.ceil(0.4 * observationHz));
      assert.equal(row.actions, Math.ceil(0.4 * controlHz));
      assert.equal(row.outcome, 'timeout');
    }
    const meta = JSON.parse(
      await readFile(path.join(out, 'episodes/000001/metadata.json'), 'utf8'),
    );
    assert.equal(meta.kind, 'dataset');
    assert.equal(meta.schemaVersion, 10);
    assert.equal(meta.config.run.cameraSeed, c.run.cameraSeed);
    assert.equal(meta.policy.profileHash, manifest.profileHash);
    const npz = readNpz(new Uint8Array(await readFile(path.join(out, 'episodes/000000/data.npz'))));
    assert.deepEqual(Object.keys(npz).sort(), [
      'act.continuous',
      'act.controller',
      'act.executed',
      'act.label_valid',
      'act.tick',
      'act.time',
      'diag.actuators',
      'diag.blocks',
      'diag.contacts',
      'diag.fingers',
      'diag.phase',
      'diag.state',
      'diag.target',
      'diag.tcp',
      'diag.tick',
      'diag.time',
      'obs.camera_to_world',
      ...(depth ? ['obs.depth'] : []),
      'obs.state',
      'obs.tick',
      'obs.time',
    ]);
    assert(
      Array.from(npz['act.controller'].data as Uint8Array).every(
        (c) => c === meta.format.controllers.indexOf('external-policy'),
      ),
    );
    if (observationHz === 20) {
      const cliOut = path.join(root, 'cli');
      const run = await cli([
        'policy',
        '--url',
        svc.url,
        '--seed',
        '2026',
        '--theme',
        'studio',
        '--out',
        cliOut,
      ]);
      assert.equal(run.code, 0, run.stderr);
      const recorded = JSON.parse(
        await readFile(path.join(cliOut, 'episodes/000000/metadata.json'), 'utf8'),
      );
      assert.equal(recorded.config.run.seed, 2026);
      assert.equal(recorded.config.run.cameraSeed, 42);
      assert.equal(recorded.appearance.id, 'studio');
      assert.equal(recorded.policy.profile.trainingAppearance.id, 'island');
      const resume = await cli([
        'collect',
        '--policy',
        svc.url,
        '--seed',
        '2026',
        '--out',
        cliOut,
        '--resume',
        '--theme',
        'studio',
      ]);
      assert.equal(resume.code, 0, resume.stderr);
      assert.equal(JSON.parse(resume.stdout).completedThisRun, 0);
      const conflict = await cli([
        'collect',
        '--policy',
        svc.url,
        '--out',
        path.join(root, 'conflict'),
        '--width',
        '123',
      ]);
      assert.equal(conflict.code, 1);
      assert.match(conflict.stderr, /conflicts/);
      const workers = await cli(['collect', '--policy', svc.url, '--workers', '2']);
      assert.equal(workers.code, 1);
      assert.match(workers.stderr, /one worker/);
      passed.push(
        'CLI policy seed, fixed camera seed, same-identity resume, conflicting flags and workers rejected',
      );
    }
    await svc.close();
    assert.equal((await replay(path.join(out, 'episodes/000000'))).outcome, 'timeout');
    passed.push(
      `RGB${depth ? '-D' : ''} ${observationHz}/${controlHz} Hz, two seeds, busy rejection, dataset inspection, offline replay`,
    );
    // A new model revision cannot resume an existing data plan.
    if (observationHz === 10) {
      const other = await server(c, 'normal', 'probe-v2');
      const h = new BrowserHost();
      await h.start();
      const p = await h.newPage();
      const m2 = await connect(p, other.url);
      await bind(p, c);
      await assert.rejects(
        collect(c, {
          out,
          seeds: [42, 2026],
          workers: 1,
          resume: true,
          policy: { manifest: m2, host: h, page: p },
        }),
        /mismatch/,
      );
      await h.close();
      await other.close();
      passed.push('resume rejects model revision change');
    }
  }
  const appearanceConfig = resolveConfig({
    camera: { width: 64, heightPixels: 48 },
    run: { maxSeconds: 0.2 },
  });
  const appearanceService = await server(appearanceConfig);
  const appearanceHost = new BrowserHost();
  try {
    await appearanceHost.start();
    const appearancePage = await appearanceHost.newPage();
    const manifest = await connect(appearancePage, appearanceService.url);
    const original = structuredClone(manifest);
    await bind(appearancePage, appearanceConfig);
    const source = await provenance();
    for (const [index, theme] of THEME_IDS.entries()) {
      const config = resolveConfig(appearanceConfig, { appearance: { theme } });
      const writer = new EpisodeWriter(
        path.join(root, 'appearances'),
        String(index).padStart(6, '0'),
        config,
        source,
        manifest,
      );
      await writer.begin();
      try {
        const output = await appearanceHost.run(appearancePage, config, writer);
        await writer.finish(output.result, output.metrics);
      } finally {
      }
      await inspect(writer.destination);
      const metadata = JSON.parse(
        await readFile(path.join(writer.destination, 'metadata.json'), 'utf8'),
      );
      assert.deepEqual(metadata.appearance, appearanceIdentity(theme));
      assert.deepEqual(metadata.policy.profile, original.profile);
      assert.equal(metadata.policy.profileHash, original.profileHash);
      await replay(writer.destination);
    }
    assert.deepEqual(manifest, original);
    passed.push(
      'one policy connection runs all themes, preserves training Profile, records actual appearance, inspects and replays',
    );
  } finally {
    await appearanceHost.close();
    await appearanceService.close();
  }
  await host.start();
  const config = resolveConfig({ camera: { width: 64, heightPixels: 48 }, run: { maxSeconds: 3 } });
  const svc = await server(config, 'slow');
  const page = await host.newPage();
  await page.addInitScript(() => localStorage.setItem('stackling.language', 'en'));
  await page.goto(host.url);
  await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
  await page.evaluate(async () => {
    (window as any).policyUIStore = (await import('/src/app/web/store.ts' as string)).useUI;
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(async () => {
    const r = (window as any).stacklingUI;
    const { cubeObjects } = await import('/src/simulation/world/objects.ts' as string);
    await r.beginEdit();
    r.updateDraft({ scene: { objects: cubeObjects(3, 0.06) }, run: { maxSeconds: 3 } });
    r.updateSceneSeed(42);
    await r.applyEdit();
    r.setTheme('studio');
  });
  await page.getByRole('button', { name: 'External Policy', exact: true }).click();
  const canvasBefore = await page.locator('#viewport > canvas').boundingBox();
  await page.locator('#policy-url').fill(svc.url);
  await page.locator('#policy-connect').click();
  await page.locator('#policy-bind').waitFor();
  assert((await page.locator('[data-policy-diff]').innerText()).includes('64'));
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.config.camera.width), 320);
  // A server-side calibration rejection must preserve the exact original scene.
  await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    (window as any).originalPolicyView = r.episode;
    const session = r.policy,
      request = session.request.bind(session);
    session.request = (type: string, expected: string, fields: any, ...rest: any[]) => {
      if (type === 'configure') fields.calibration.position[0] += 1;
      return request(type, expected, fields, ...rest);
    };
  });
  await page.locator('#policy-bind').click();
  await page.waitForFunction(() => {
    const useUI = (window as any).policyUIStore;
    return useUI.getState().policyStatus === 'fault';
  });
  assert(
    await page.evaluate(
      () => (window as any).stacklingUI.episode === (window as any).originalPolicyView,
    ),
  );
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.config.camera.width), 320);
  await page.locator('#policy-disconnect').click();
  await page.waitForFunction(() => {
    const useUI = (window as any).policyUIStore;
    return useUI.getState().policyStatus === 'disconnected';
  });
  await page.locator('#policy-connect').click();
  await page.locator('#policy-bind').waitFor();
  await page.locator('#policy-bind').click();
  await page.waitForFunction(() => {
    const useUI = (window as any).policyUIStore;
    return useUI.getState().policyStatus === 'bound';
  });
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.config.camera.width), 64);
  assert.equal(
    await page.evaluate(() => (window as any).stacklingUI.config.appearance.theme),
    'studio',
  );
  assert.equal(
    await page.evaluate(() => (window as any).stacklingUI.config.scene.objects.length),
    3,
  );
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.config.run.maxSeconds), 3);
  assert((await page.locator('[data-policy-panel]').innerText()).includes('Appearance Evaluation'));
  assert(await page.getByRole('button', { name: 'Settings', exact: true }).isEnabled());
  assert.equal(await page.locator('#teacher').count(), 0);
  assert.equal(await page.getByRole('combobox', { name: 'Stacking Speed' }).count(), 0);
  assert.equal(await page.locator('#policy-stop').count(), 0);
  assert(await page.getByRole('button', { name: 'Reset', exact: true }).isDisabled());
  const playWidth = (await page.locator('#play').boundingBox())!.width;
  assert.deepEqual(await page.locator('#viewport > canvas').boundingBox(), canvasBefore);
  assert(
    await page.evaluate(() => {
      const r = (window as any).stacklingUI;
      return !r.request() && !r.teacher();
    }),
  );
  await page.evaluate(() => {
    (window as any).boundEpisode = (window as any).stacklingUI.episode;
  });
  await page.locator('#policy-config').click();
  await page.locator('[data-policy-panel]').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert(await page.getByLabel('Block Count', { exact: true }).isEnabled());
  assert(await page.getByRole('combobox', { name: 'Block Size', exact: true }).isEnabled());
  assert.equal(await page.getByRole('button', { name: 'Apply & Reset' }).count(), 1);
  await page.getByRole('tab', { name: 'Camera', exact: true }).click();
  assert.equal(await page.getByLabel('Width · px', { exact: true }).inputValue(), '64');
  assert(await page.locator('[data-camera="N"]').isDisabled());
  assert(await page.getByRole('switch', { name: 'Capture Depth' }).isDisabled());
  assert(
    await page.evaluate(() => (window as any).stacklingUI.episode === (window as any).boundEpisode),
  );
  assert.deepEqual(await page.locator('#viewport > canvas').boundingBox(), canvasBefore);
  await page.keyboard.press('Escape');
  await page.locator('#policy').click();
  await page.locator('#play').click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'running');
  await page.waitForFunction(
    () => (window as any).stacklingUI.episode.source.actions.session['pending'].size > 0,
  );
  await page.locator('#play').click();
  await page.evaluate(() => (window as any).stacklingUI.episode.settled());
  assert.deepEqual(
    await page.evaluate(async () => {
      const r = (window as any).stacklingUI;
      return [r.updateSceneSeed(2026), await r.applySceneSeed(), await r.shuffle()];
    }),
    [false, false, false],
  );
  assert.equal((await page.locator('#play').boundingBox())!.width, playWidth);
  assert(await page.getByRole('button', { name: 'Reset', exact: true }).isEnabled());
  const tick = await page.evaluate(() => (window as any).stacklingUI.episode.sim.ticks);
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.episode.sim.ticks), tick);
  const before = await page.evaluate(() => (window as any).stacklingUI.orbit.getAzimuthalAngle());
  await page.mouse.move(500, 400);
  await page.mouse.down();
  await page.mouse.move(650, 410, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.notEqual(
    await page.evaluate(() => (window as any).stacklingUI.orbit.getAzimuthalAngle()),
    before,
  );
  await page.locator('#play').click();
  await page.waitForFunction(() => (window as any).stacklingUI.episode.sim.ticks > 0);
  assert(await page.getByRole('button', { name: 'Reset', exact: true }).isDisabled());
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.request()), false);
  await page.waitForFunction(() =>
    [...(window as any).stacklingUI.policy.pending.values()].some(
      (p: any) => p.message.type === 'act',
    ),
  );
  assert.deepEqual(
    await page.evaluate(async () => {
      const r = (window as any).stacklingUI;
      await r.toggle();
      (window as any).resetEpisode = r.episode;
      (window as any).resetEpisodeId = r.policy.episodeId;
      (window as any).oldActionCount = r.episode.actions;
      return [r.request(), r.request(), await r.toggle(), r.mode];
    }),
    [true, false, false, 'resetting'],
  );
  await page.waitForFunction(() => {
    const useUI = (window as any).policyUIStore;
    return useUI.getState().policyStatus === 'bound' && (window as any).stacklingUI.mode === 'idle';
  });
  assert.deepEqual(
    await page.evaluate(() => {
      const r = (window as any).stacklingUI;
      return {
        mode: r.mode,
        sameEpisode: r.episode === (window as any).resetEpisode,
        source: r.episode.source.actions?.name ?? r.episode.source.kind,
        seed: r.config.run.seed,
        tick: r.episode.sim.ticks,
        episodeId: r.policy.episodeId,
        lateActions: (window as any).resetEpisode.actions - (window as any).oldActionCount,
      };
    }),
    {
      mode: 'idle',
      sameEpisode: false,
      source: 'manual',
      seed: 42,
      tick: 0,
      episodeId: null,
      lateActions: 0,
    },
  );
  const resetSnapshot = await page.evaluate(() =>
    (window as any).stacklingUI.episode.sim.inspect(),
  );
  await page.waitForTimeout(500);
  assert.deepEqual(
    await page.evaluate(() => (window as any).stacklingUI.episode.sim.inspect()),
    resetSnapshot,
  );
  assert(await page.getByRole('button', { name: 'Reset', exact: true }).isDisabled());
  await page.locator('#play').click();
  await page.waitForFunction(() => (window as any).stacklingUI.episode.sim.ticks > 0);
  assert(
    await page.evaluate(
      () => (window as any).stacklingUI.policy.episodeId !== (window as any).resetEpisodeId,
    ),
  );
  await page.waitForFunction(
    () => {
      const useUI = (window as any).policyUIStore;
      return (
        (window as any).stacklingUI.mode === 'finished' && useUI.getState().policyStatus === 'bound'
      );
    },
    null,
    { timeout: 60000 },
  );
  assert.equal(await page.locator('#play').getAttribute('aria-label'), 'Run Again');
  assert.equal((await page.locator('#play').boundingBox())!.width, playWidth);
  await page.screenshot({ path: await reportPath('policy-toolbar.png') });
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  assert.deepEqual(
    await page.evaluate(() => (window as any).stacklingUI.episode.sim.inspect()),
    resetSnapshot,
  );
  await page.locator('#policy-config').click();
  await page.locator('[data-policy-panel]').waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  assert(await page.locator('#scene-seed').isEnabled());
  assert.equal(await page.getByRole('button', { name: 'Restore Defaults' }).count(), 1);
  await page.locator('#scene-seed').fill('2026');
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.config.run.seed), 42);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.locator('#scene-seed').inputValue(), '42');
  await page.locator('#scene-seed').fill('-1');
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.applyEdit()), false);
  await page.locator('#scene-seed').fill('2026');
  await page.getByRole('button', { name: 'Apply & Reset' }).click();
  await page.getByRole('button', { name: 'Generate Scene', exact: true }).click();
  await page.locator('#policy').click();
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.config.run.seed), 2026);
  await page.screenshot({ path: path.join(root, 'policy-bound.png') });
  await copyFile(path.join(root, 'policy-bound.png'), await reportPath('policy-bound.png'));
  const competitor = await host.newPage();
  await page.locator('#play').click();
  await page.waitForFunction(() =>
    [...(window as any).stacklingUI.policy.pending.values()].some(
      (p: any) => p.message.type === 'act',
    ),
  );
  const faultyTick = await page.evaluate(() => {
    const r = (window as any).stacklingUI,
      session = r.policy;
    const pending = [...session.pending.values()].find((p: any) => p.message.type === 'act') as any;
    session.receive(
      JSON.stringify({
        type: 'action',
        sessionId: session.id,
        episodeId: 'wrong-episode',
        requestId: pending.message.requestId,
        tick: pending.message.tick,
        action: r.episode.sim.state(),
        continuous: false,
      }),
    );
    return r.episode.sim.ticks;
  });
  await assert.rejects(connect(competitor, svc.url), /SERVER_BUSY/);
  await competitor.close();
  await page.waitForTimeout(500);
  assert.equal(
    await page.evaluate(() => (window as any).stacklingUI.episode.sim.ticks),
    faultyTick,
  );
  assert(await page.getByRole('button', { name: 'Settings', exact: true }).isEnabled());
  await page.locator('#policy-disconnect').click();
  await page.waitForFunction(() => {
    const useUI = (window as any).policyUIStore;
    return useUI.getState().policyStatus === 'disconnected';
  });
  assert(await page.getByRole('button', { name: 'Settings', exact: true }).isEnabled());
  assert(await page.locator('#teacher').isVisible());
  assert(await page.getByRole('combobox', { name: 'Stacking Speed' }).isVisible());
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.config.camera.width), 64);
  await page.close();
  await svc.close();
  passed.push(
    'desktop review/apply, failed bind rollback, config lock, pause/resume, responsive orbit during inference, paused/finished reset, fixed button width, late action discard, seed, wrong episode rejection, lease retained while callback drains, disconnect',
  );
  for (const mode of ['reset-error', 'invalid', 'model-error', 'slow', 'reset-slow']) {
    const c = resolveConfig({ camera: { width: 32, heightPixels: 24 }, run: { maxSeconds: 0.2 } });
    const svc = await server(c, mode);
    const h = new BrowserHost();
    await h.start();
    const p = await h.newPage();
    const m = await connect(
      p,
      svc.url,
      '',
      mode === 'slow' ? 150 : 30000,
      mode === 'reset-slow' ? 100 : 120000,
    );
    await bind(p, c);
    const out = path.join(root, mode);
    await assert.rejects(
      collect(c, { out, seeds: [42, 2026], workers: 1, policy: { manifest: m, host: h, page: p } }),
      mode === 'invalid' ? /INVALID_ACTION/ : mode.includes('slow') ? /TIMEOUT/ : /MODEL_ERROR/,
    );
    const index = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(index.status, 'error');
    assert.equal(Object.keys(index.completed).length, 0);
    await readFile(path.join(out, 'episodes/.000000.partial/interruption.json'));
    await svc.close();
    passed.push(`${mode}: stops plan, preserves partial and interruption`);
  }
  {
    const svc = await server(config, 'slow');
    const h = new BrowserHost();
    await h.start();
    const p = await h.newPage();
    await p.evaluate(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && JSON.parse(data).type === 'act')
          (window as any).policyActSeen = true;
        return send.call(this, data);
      };
    });
    const m = await connect(p, svc.url);
    await bind(p, config);
    const out = path.join(root, 'disconnect');
    const run = collect(config, {
      out,
      seeds: [42, 2026],
      workers: 1,
      policy: { manifest: m, host: h, page: p },
    });
    const rejected = assert.rejects(run, /DISCONNECTED/);
    await p.waitForFunction(() => (window as any).policyActSeen);
    await svc.close();
    await rejected;
    const index = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(Object.keys(index.completed).length, 0);
    await readFile(path.join(out, 'episodes/.000000.partial/interruption.json'));
    passed.push(
      'server disconnect aborts collection, preserves partial, does not assign next seed',
    );
  }
  const auth = await server(config, 'normal', 'auth', 'secret');
  const p = await host.newPage();
  await assert.rejects(connect(p, auth.url, 'wrong'), /AUTH_FAILED/);
  await p.close();
  await auth.close();
  passed.push('authentication failure');
  const demoOut = path.join(root, 'demo');
  const demo = spawn(
    process.execPath,
    ['src/app/cli/main.ts', 'policy-demo', '--out', demoOut, '--seed', '42', '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.add(demo);
  const demoLogs = await new Promise<string>((resolve, reject) => {
    let logs = '';
    const timer = setTimeout(() => reject(new Error(`policy-demo startup: ${logs}`)), 60000);
    const onChunk = (chunk: Buffer) => {
      logs += chunk;
      if (/Uvicorn running on http:\/\/127\.0\.0\.1:\d+/.test(logs)) {
        clearTimeout(timer);
        resolve(logs);
      }
    };
    demo.stdout!.on('data', onChunk);
    demo.stderr!.on('data', onChunk);
    demo.once('exit', (code) => reject(new Error(`policy-demo exited ${code}: ${logs}`)));
  });
  const demoPort = demoLogs.match(/Uvicorn running on http:\/\/127\.0\.0\.1:(\d+)/)![1];
  const demoHealth = await (await fetch(`http://127.0.0.1:${demoPort}/health`)).json();
  assert.equal(demoHealth.policyId, 'replay-demo');
  assert.equal(demoHealth.busy, false);
  assert.match(demoHealth.modelRevision, /^replay-/);
  const demoMeta = JSON.parse(
    await readFile(path.join(demoOut, 'episodes/000000/metadata.json'), 'utf8'),
  );
  assert.equal(demoMeta.result.outcome, 'success');
  await readFile(path.join(demoOut, 'profile.json'));
  const liveDemoOut = path.join(root, 'demo-studio');
  const liveDemo = await cli([
    'policy',
    '--url',
    `ws://127.0.0.1:${demoPort}/policy`,
    '--seed',
    '42',
    '--theme',
    'studio',
    '--out',
    liveDemoOut,
  ]);
  assert.equal(liveDemo.code, 0, liveDemo.stderr);
  assert.equal(JSON.parse(liveDemo.stdout).successesThisRun, 1);
  assert.equal((await inspect(liveDemoOut))[0].outcome, 'success');
  assert.equal((await replay(path.join(liveDemoOut, 'episodes/000000'))).outcome, 'success');
  demo.kill('SIGTERM');
  const [demoCode] = await once(demo, 'close');
  children.delete(demo);
  assert.equal(demoCode, 0);
  passed.push(
    'policy-demo records, exports, serves and succeeds via live callbacks in Studio, with offline inspection/replay',
  );
  {
    const base = resolveConfig({
      camera: { width: 64, heightPixels: 48 },
      run: { maxSeconds: 0.2 },
    });
    const { randomMixedObjects } = await import('../../src/simulation/world/objects');
    const partition = resolveConfig(base, {
      task: { kind: 'partition-count', counts: [1, 1], language: 'zh' },
      appearance: { theme: 'studio' },
    });
    const height = resolveConfig(base, {
      scene: { objects: randomMixedObjects(7, 2026) },
      task: { kind: 'max-height', language: 'zh' },
      appearance: { theme: 'island' },
      run: { cameraSeed: 2026 },
    });
    const svc = await server(base, 'normal', 'multitask');
    const collector = new BrowserHost();
    await collector.start();
    const page = await collector.newPage();
    const manifest = await connect(page, svc.url);
    await bind(page, base);
    const out = path.join(root, 'multitask');
    const summary = await collect(base, {
      out,
      seeds: [42],
      workers: 1,
      cases: [base, partition, height],
      policy: { manifest, host: collector, page },
    });
    assert.equal(summary.byCase.length, 3);
    const rows = await inspect(out);
    assert.deepEqual(
      rows.map((r) => r.outcome),
      ['timeout', 'timeout', 'completed'],
    );
    assert.equal((await replay(path.join(out, 'episodes/000002'))).outcome, 'completed');
    const originalMetadata = await readFile(
      path.join(out, 'episodes/000002/metadata.json'),
      'utf8',
    );
    const saved = JSON.parse(originalMetadata);
    assert.equal(saved.policy.profile.trainingTasks.length, 1);
    assert.equal(saved.config.scene.objects.length, 7);
    assert.equal(saved.result.task.prompt.language, 'zh');
    assert.equal(saved.appearance.id, 'island');
    const resumeHost = new BrowserHost();
    await resumeHost.start();
    const resumePage = await resumeHost.newPage();
    const resumedManifest = await connect(resumePage, svc.url);
    await bind(resumePage, base);
    const changedPrompt = resolveConfig(height, { task: { language: 'en' } });
    await assert.rejects(
      collect(base, {
        out,
        seeds: [42],
        workers: 1,
        resume: true,
        cases: [base, partition, changedPrompt],
        policy: { manifest: resumedManifest, host: resumeHost, page: resumePage },
      }),
      /Resume configuration\/source mismatch/,
    );
    const changedTheme = resolveConfig(height, { appearance: { theme: 'studio' } });
    await assert.rejects(
      collect(base, {
        out,
        seeds: [42],
        workers: 1,
        resume: true,
        cases: [base, partition, changedTheme],
        policy: { manifest: resumedManifest, host: resumeHost, page: resumePage },
      }),
      /Resume configuration\/source mismatch/,
    );
    const resumed = await collect(base, {
      out,
      seeds: [42],
      workers: 1,
      resume: true,
      cases: [base, partition, height],
      policy: { manifest: resumedManifest, host: resumeHost, page: resumePage },
    });
    assert.equal(resumed.completedThisRun, 0);
    assert.equal(
      await readFile(path.join(out, 'episodes/000002/metadata.json'), 'utf8'),
      originalMetadata,
    );
    const tampered = structuredClone(saved);
    tampered.result.task.prompt.text += ' changed';
    await writeFile(path.join(out, 'episodes/000002/metadata.json'), JSON.stringify(tampered));
    await assert.rejects(
      inspect(path.join(out, 'episodes/000002')),
      /Task prompt\/rules metadata mismatch/,
    );
    await writeFile(path.join(out, 'episodes/000002/metadata.json'), originalMetadata);
    for (let i = 0; i < 100; i++) {
      const health = await (
        await fetch(svc.url.replace('ws://', 'http://').replace('/policy', '/health'))
      ).json();
      if (!health.busy) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const ui = await host.newPage();
    await ui.addInitScript(() => localStorage.setItem('stackling.language', 'en'));
    await ui.goto(host.url);
    await ui.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
    await ui.evaluate(async (url) => {
      const r = (window as any).stacklingUI;
      {
        if (!(await r.connectPolicy({ url }))) throw new Error('UI connect failed');
        if (!(await r.bindPolicy())) throw new Error('UI bind failed');
      }
    }, svc.url);
    const settings = ui.getByRole('button', { name: 'Settings', exact: true });
    const selectCase = async (label: string) => {
      await ui.locator('#task-preset').click();
      assert.equal(await ui.getByRole('option').count(), 6);
      await ui.getByRole('option', { name: label, exact: true }).click();
      await ui.getByRole('listbox').waitFor({ state: 'hidden' });
    };
    assert.equal(
      await ui.evaluate(() => (window as any).stacklingUI.selectTask('stack-ordered')),
      true,
    );
    assert.equal(await ui.evaluate(() => (window as any).stacklingUI.selectTask(99)), false);
    await selectCase('Maximum stable height');
    await ui.waitForFunction(() => (window as any).stacklingUI.config.task.kind === 'max-height');
    assert.equal(
      await ui.getByRole('dialog', { name: 'Settings', exact: true }).isVisible(),
      false,
    );
    await ui.evaluate(() => {
      (window as any).caseOriginal = (window as any).stacklingUI.episode;
    });
    await settings.click();
    assert.equal(await ui.locator('[data-settings] #policy-task-case').count(), 0);
    assert.equal(await ui.getByLabel('Object count', { exact: true }).isEnabled(), true);
    await ui.getByLabel('Object count', { exact: true }).fill('8');
    await ui.waitForFunction(
      () => (window as any).stacklingUI.episode.config.scene.objects.length === 8,
    );
    assert.equal(
      await ui.evaluate(() =>
        (window as any).stacklingUI.updateDraft({
          camera: { width: 128 },
        }),
      ),
      false,
    );
    await ui.keyboard.press('Escape');
    await ui.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' });
    assert(
      await ui.evaluate(() => (window as any).stacklingUI.episode === (window as any).caseOriginal),
    );
    await selectCase('Stack all cubes');
    await ui.waitForFunction(() => (window as any).stacklingUI.config.task.kind === 'tower');
    await selectCase('Maximum stable height');
    await ui.waitForFunction(() => (window as any).stacklingUI.config.task.kind === 'max-height');
    await settings.click();
    await ui.getByLabel('Object count', { exact: true }).fill('8');
    await ui.getByRole('tab', { name: 'Run', exact: true }).click();
    await ui.getByLabel('Time Limit · s', { exact: true }).fill('1');
    await ui.getByRole('button', { name: 'Apply & Reset', exact: true }).click();
    const connectionBefore = await ui.evaluate(() => (window as any).stacklingUI.policy.id);
    const profileBefore = await ui.evaluate(
      () => (window as any).stacklingUI.policy.manifest.profileHash,
    );
    const inventoryBefore = await ui.evaluate(
      () => (window as any).stacklingUI.config.scene.objects,
    );
    await ui.getByRole('button', { name: 'Generate Scene', exact: true }).click();
    assert.notDeepEqual(
      await ui.evaluate(() => (window as any).stacklingUI.config.scene.objects),
      inventoryBefore,
    );
    assert.equal(
      await ui.evaluate(() => (window as any).stacklingUI.config.scene.objects.length),
      8,
    );
    await ui.evaluate(() => (window as any).stacklingUI.setTheme('studio'));
    await ui.locator('#language').click();
    await ui.locator('#play').click();
    await ui.waitForFunction(() => (window as any).stacklingUI.mode === 'finished', undefined, {
      timeout: 15000,
    });
    assert.equal(
      await ui.evaluate(() => (window as any).stacklingUI.episode.result.outcome),
      'completed',
    );
    assert.equal(
      await ui.evaluate(() => (window as any).stacklingUI.episode.result.task.prompt.language),
      'zh',
    );
    assert.equal(await ui.evaluate(() => (window as any).stacklingUI.policy.id), connectionBefore);
    assert.equal(
      await ui.evaluate(() => (window as any).stacklingUI.policy.manifest.profileHash),
      profileBefore,
    );
    await ui.close();
    await svc.close();
    passed.push(
      'one connection changes undeclared task/scene/theme, preserves prompt-only callbacks, records/replays/resumes independent episode plans, and permits bound task parameters while enforcing runtime compatibility',
    );
  }
  {
    const runtime = resolveConfig({
      environment: { physicsHz: 100 },
      camera: { width: 64, heightPixels: 48 },
      run: { controlHz: 20, observationHz: 25, maxSeconds: 0.2 },
    });
    const svc = await server(runtime, 'normal', 'dynamic-cli');
    const suite = path.join(root, 'independent-suite.json');
    const { randomMixedObjects } = await import('../../src/simulation/world/objects');
    await writeFile(
      suite,
      JSON.stringify({
        cases: [
          { task: { kind: 'tower', order: 'any' } },
          {
            scene: { objects: randomMixedObjects(4, 2026) },
            task: { kind: 'max-height', language: 'zh' },
          },
        ],
      }),
    );
    const out = path.join(root, 'independent-cli');
    const args = [
      'policy',
      '--url',
      svc.url,
      '--task-suite',
      suite,
      '--seed',
      '42',
      '--seconds',
      '0.2',
      '--observation-hz',
      '25',
      '--theme',
      'studio',
      '--out',
      out,
    ];
    const run = await cli(args);
    assert.equal(run.code, 0, run.stderr);
    const rows = await inspect(out);
    assert.deepEqual(
      rows.map((r) => r.outcome),
      ['timeout', 'completed'],
    );
    const metadata = JSON.parse(
      await readFile(path.join(out, 'episodes/000001/metadata.json'), 'utf8'),
    );
    assert.equal(metadata.config.scene.objects.length, 4);
    assert.deepEqual(metadata.config.scene.objects, randomMixedObjects(4, 2026));
    assert.equal(metadata.config.environment.physicsHz, 100);
    assert.equal(metadata.appearance.id, 'studio');
    assert.equal(metadata.result.task.prompt.language, 'zh');
    const checksum = await digest(metadata);
    const resumed = await cli([...args, '--resume']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).completedThisRun, 0);
    assert.equal(
      await digest(
        JSON.parse(await readFile(path.join(out, 'episodes/000001/metadata.json'), 'utf8')),
      ),
      checksum,
    );
    passed.push(
      'CLI adopts runtime before resolving an independent task suite, supports 100/25/20 Hz, records current scene/theme/prompt and resumes unchanged episodes',
    );
    const randomOut = path.join(root, 'random-height-cli');
    const randomArgs = [
      'collect',
      '--policy',
      svc.url,
      '--task-preset',
      'max-height',
      '--blocks',
      '5',
      '--seeds',
      '0,1',
      '--seconds',
      '0.2',
      '--out',
      randomOut,
    ];
    const randomRun = await cli(randomArgs);
    assert.equal(randomRun.code, 0, randomRun.stderr);
    const manifest = JSON.parse(await readFile(path.join(randomOut, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.sceneGeneration, { kind: 'random-mixed', version: 2, count: 5 });
    for (const entry of manifest.plan)
      assert.deepEqual(
        entry.config.scene.objects,
        generatedObjects(
          { kind: 'random-mixed', version: 2, count: 5 },
          entry.config.run.seed,
          entry.config.scene.maxStackHeight,
        ),
      );
    assert((await inspect(randomOut)).every((row) => row.outcome === 'completed'));
    const randomMetadataPath = path.join(randomOut, 'episodes/000000/metadata.json');
    const randomBefore = await readFile(randomMetadataPath, 'utf8');
    const randomMetadata = JSON.parse(randomBefore);
    assert.equal(randomMetadata.config.environment.physicsHz, 100);
    assert.equal(randomMetadata.policy.profileHash, metadata.policy.profileHash);
    const randomResume = await cli([...randomArgs, '--resume']);
    assert.equal(randomResume.code, 0, randomResume.stderr);
    assert.equal(JSON.parse(randomResume.stdout).completedThisRun, 0);
    assert.equal(await readFile(randomMetadataPath, 'utf8'), randomBefore);
    await svc.close();
    passed.push(
      'CLI external-policy height collection randomizes inventories per seed without a suite, retains the runtime contract and resumes unchanged',
    );
  }

  {
    const runtime = resolveConfig({
      environment: { physicsHz: 100 },
      camera: { width: 64, heightPixels: 48, depth: true },
      run: { controlHz: 20, observationHz: 25, maxSeconds: 0.2 },
    });
    const svc = await server(runtime, 'capture', 'capture-v1');
    const args = [
      '--task-preset',
      'max-height',
      '--blocks',
      '8',
      '--seeds',
      '0',
      '--seconds',
      '0.2',
    ];
    const full = path.join(root, 'parity-full'),
      light = path.join(root, 'parity-light');
    const fullRun = await cli(['collect', '--policy', svc.url, ...args, '--out', full]);
    assert.equal(fullRun.code, 0, fullRun.stderr);
    const lightRun = await cli(['evaluate', '--policy', svc.url, ...args, '--out', light]);
    assert.equal(lightRun.code, 0, lightRun.stderr);
    assert.deepEqual((await report(full)).byTask, (await report(light)).byTask);
    const ownHost = new BrowserHost();
    await ownHost.start();
    const page = await ownHost.newPage();
    let intercepted = 0;
    await page.route('**/src/runtime/browser/encode-worker.ts*', async (route) => {
      intercepted++;
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: `globalThis.VideoEncoder = undefined;\n${await response.text()}`,
      });
    });
    let uploads = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/chunk/')) uploads++;
    });
    const m = await connect(page, svc.url);
    const current = resolveConfig(runtime, {
      task: { kind: 'max-height' },
      scene: {
        objects: generatedObjects(
          { kind: 'random-mixed', version: 2, count: 8 },
          0,
          runtime.scene.maxStackHeight,
        ),
      },
      run: { seed: 0 },
    });
    await bind(page, current);
    const noCodec = path.join(root, 'no-video-encoder');
    await evaluate(current, {
      out: noCodec,
      seeds: [0],
      workers: 1,
      policy: { manifest: m, host: ownHost, page },
    });
    assert.equal(uploads, 0);
    assert(intercepted > 0);
    const traces = (await readFile(path.join(root, 'capture-trace.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(traces.length, 3);
    assert.deepEqual(traces[0], traces[1]);
    assert.deepEqual(traces[1], traces[2]);
    assert.equal(traces[0].observations.length, 5);
    assert.equal(traces[0].actions.length, 4);
    const before = await readFile(path.join(light, 'episodes/000000/result.json'), 'utf8');
    const resumed = await cli([
      'evaluate',
      '--policy',
      svc.url,
      ...args,
      '--out',
      light,
      '--resume',
    ]);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).completedThisRun, 0);
    assert.equal(await readFile(path.join(light, 'episodes/000000/result.json'), 'utf8'), before);
    await svc.close();
    const changed = await server(runtime, 'normal', 'capture-v2');
    const rejected = await cli([
      'evaluate',
      '--policy',
      changed.url,
      ...args,
      '--out',
      light,
      '--resume',
    ]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /mismatch/);
    await changed.close();
    passed.push(
      'result-only evaluation matches full-recording RGB-D, prompts, model actions and height; works without VideoEncoder or uploads; resumes unchanged and rejects a changed model revision',
    );
  }
  {
    const c = resolveConfig({
      camera: { mount: 'head', depth: true, width: 64, heightPixels: 48 },
      run: { maxSeconds: 0.6 },
    });
    const svc = await server(c, 'head-motion');
    const ownHost = new BrowserHost();
    try {
      await ownHost.start();
      const page = await ownHost.newPage();
      const manifest = await connect(page, svc.url);
      await bind(page, c);
      const out = path.join(root, 'head-motion');
      await collect(c, { out, seeds: [42], workers: 1, policy: { manifest, host: ownHost, page } });
      await inspect(out);
      await replay(path.join(out, 'episodes/000000'));
      const traces = (await readFile(path.join(root, 'head-motion-trace.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const npz = readNpz(
        new Uint8Array(await readFile(path.join(out, 'episodes/000000/data.npz'))),
      );
      const matrices = Array.from(npz['obs.camera_to_world'].data as Float64Array);
      const observations = traces[0].observations;
      assert(observations.length > 1);
      observations.forEach((row: any, i: number) =>
        assert.deepEqual(row.camera_to_world.flat(), matrices.slice(i * 16, (i + 1) * 16)),
      );
      assert(
        observations.some((row: any) => row.state[0] > 0.01),
        'model targets must physically move the waist',
      );
      assert(
        observations.some(
          (row: any) =>
            JSON.stringify(row.camera_to_world) !== JSON.stringify(observations[0].camera_to_world),
        ),
        'head-camera extrinsics must follow measured waist motion',
      );
      assert(Array.from(npz['act.continuous'].data as Uint8Array).every((value) => value === 1));
      assert(
        traces[0].actions.every((row: any) => row.continuous === true && row.action.length === 16),
      );
      passed.push(
        'Head RGB-D observes exact moving camera transforms and measured State16D; continuous Action16D survives Python, recording, inspection and physical replay',
      );
    } finally {
      await ownHost.close();
      await svc.close();
    }
  }
  console.log(JSON.stringify({ passed, artifacts: root }, null, 2));
  await writeFile(
    await reportPath('policy.json'),
    JSON.stringify(
      {
        passed,
        artifacts: root,
        environmentFingerprint: fingerprint,
        sourceHash: (await provenance()).sourceHash,
        screenshot: 'policy-bound.png',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await host.close();
  for (const child of children) child.kill('SIGTERM');
}
