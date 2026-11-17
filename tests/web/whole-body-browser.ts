import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
import { reportPath } from '../runtime/report-path';
const host = new BrowserHost();
try {
  await host.start();
  const physicsAssets: string[] = [];
  const page = await host.newPage(),
    errors: string[] = [];
  page.on('request', (request) => {
    if (/rapier_wasm|@dimforge.*rapier/.test(request.url())) physicsAssets.push(request.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('stackling.language', 'zh'));
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(host.url);
  await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
  const switched = await page.evaluate(async () => {
    const r = (window as any).stacklingUI;
    const selected = await r.selectTask('max-height');
    const state = { selected, kind: r.config.task.kind, axes: r.episode.sim.state().length };
    await r.selectTask('stack-all');
    return state;
  });
  assert.deepEqual(switched, { selected: true, kind: 'max-height', axes: 16 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('积木数量', { exact: true }).fill('3');
  await page.getByLabel('场景种子', { exact: true }).fill('42');
  await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    r.updateDraft({ camera: { mount: 'head', depth: true } });
  });
  await page.getByRole('button', { name: '应用并重置' }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  const initial = await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    r.camera.position.set(1.7, 1.55, 2.6);
    r.orbit.target.set(0, 0.9, -0.12);
    r.orbit.update();
    r.setTeacherRate(2);
    return {
      state: r.episode.sim.state(),
      config: r.config,
      camera: r.sensor.camera.matrixWorld.toArray(),
    };
  });
  assert.equal(initial.state.length, 16);
  assert.equal(initial.config.scene.objects.length, 3);
  await page.locator('#teacher').click();
  await page.waitForFunction(
    () => (window as any).stacklingUI.episode.phase === 'carry',
    undefined,
    { timeout: 120000 },
  );
  await page.locator('#play').click();
  const optics = await page.evaluate(async () => {
    const r = (window as any).stacklingUI;
    await r.episode.settled();
    r.scene.sync();
    r.sensor.capture();
    const load = (p: string) => import(p),
      { Vector3, Quaternion } = await load('/node_modules/three/build/three.module.js');
    const lens = r.scene.scene.getObjectByName('head-camera-lens');
    const axis = new Vector3(0, 0, 1).applyQuaternion(lens.getWorldQuaternion(new Quaternion()));
    return {
      camera: r.sensor.camera.matrixWorld.toArray(),
      axisError: axis.distanceTo(r.sensor.camera.getWorldDirection(new Vector3())),
      lensError: r.sensor.camera.position.distanceTo(
        lens.getWorldPosition(new Vector3()).addScaledVector(axis, 0.002),
      ),
      time: r.episode.sim.time,
    };
  });
  assert(optics.axisError < 1e-7 && optics.lensError < 1e-7, JSON.stringify(optics));
  await page.screenshot({
    path: await reportPath(
      'whole-body-working.png',
      process.env.REPORT_DIR ? `${process.env.REPORT_DIR}/whole-body-working.png` : undefined,
    ),
  });
  await page.getByRole('button', { name: '切换到第一人称', exact: true }).click();
  await page.waitForTimeout(150);
  await page.screenshot({
    path: await reportPath(
      'whole-body-head.png',
      process.env.REPORT_DIR ? `${process.env.REPORT_DIR}/whole-body-head.png` : undefined,
    ),
  });
  const sensorUnchanged = await page.evaluate((matrix: number[]) => {
    const r = (window as any).stacklingUI;
    r.sensor.capture();
    return matrix.every((v, i) => v === r.sensor.camera.matrixWorld.elements[i]);
  }, optics.camera);
  assert(sensorUnchanged, 'Viewport switching must not change sensor pose');
  await page.getByRole('button', { name: '切换到全景', exact: true }).click();
  await page.locator('#play').click();
  await page.waitForFunction(() => Boolean((window as any).stacklingUI.episode.result), undefined, {
    timeout: 180000,
  });
  const result = await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    return { result: r.episode.result, decisions: r.episode.source.teacher.decisions };
  });
  assert.equal(result.result.outcome, 'success');
  assert(new Set(result.decisions.map((d: { arm: number }) => d.arm)).size === 2);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '运行', exact: true }).click();
  assert(await page.getByText('腰部转向', { exact: true }).isVisible());
  assert(await page.getByText('右臂 · 夹爪', { exact: true }).isVisible());
  await page.screenshot({
    path: await reportPath(
      'whole-body-settings.png',
      process.env.REPORT_DIR ? `${process.env.REPORT_DIR}/whole-body-settings.png` : undefined,
    ),
  });
  await page.keyboard.press('Escape');
  // Exercise the sensor mount independently: a task can legitimately keep its waist still.
  const commandedOptics = await page.evaluate(async () => {
    const load = (p: string) => import(p);
    const { Vector3, Quaternion } = await load('/node_modules/three/build/three.module.js');
    const { WorldClient: Simulation } = await load('/src/runtime/client/world-client.ts');
    const { worldConfig } = await load('/src/simulation/scene.ts');
    const { WorldScene } = await load('/src/runtime/browser/render/rendering.ts');
    const { SensorCamera } = await load('/src/runtime/browser/render/camera.ts');
    const config = (window as any).stacklingUI.config;
    const sim = await Simulation.create(worldConfig(config));
    const scene = new WorldScene(sim, 'studio', config.camera.head.pitch);
    const sensor = new SensorCamera(scene, config.camera);
    try {
      sensor.capture();
      const initial = sensor.camera.matrixWorld.toArray();
      const target = sim.targetState();
      target[0] = 0.2;
      target[1] = 0.2;
      await sim.apply(target);
      for (let i = 0; i < 720; i++) await sim.step();
      sensor.capture();
      const lens = scene.scene.getObjectByName('head-camera-lens');
      const axis = new Vector3(0, 0, 1).applyQuaternion(lens.getWorldQuaternion(new Quaternion()));
      return {
        measuredWaist: sim.state().slice(0, 2),
        moved: initial.some(
          (v: number, i: number) => Math.abs(v - sensor.camera.matrixWorld.elements[i]) > 0.01,
        ),
        axisError: axis.distanceTo(sensor.camera.getWorldDirection(new Vector3())),
        lensError: sensor.camera.position.distanceTo(
          lens.getWorldPosition(new Vector3()).addScaledVector(axis, 0.002),
        ),
      };
    } finally {
      sensor.dispose();
      scene.dispose();
      await sim.dispose();
    }
  });
  assert(commandedOptics.measuredWaist.every((v: number) => Math.abs(v - 0.2) < 0.01));
  assert(
    commandedOptics.moved && commandedOptics.axisError < 1e-7 && commandedOptics.lensError < 1e-7,
    JSON.stringify(commandedOptics),
  );
  const cancellation = await page.evaluate(async () => {
    const { EpisodeClient } = await import('/src/runtime/client/episode-client.ts' as string);
    const { resolveConfig } = await import('/src/runtime/config.ts' as string);
    let cancellations = 0,
      nextStarted = false;
    let rejectNext!: (error: Error) => void;
    const source = {
      name: 'cancellation-check',
      reset() {},
      next() {
        nextStarted = true;
        return new Promise<never>((_resolve, reject) => (rejectNext = reject));
      },
      cancel() {
        cancellations++;
        rejectNext(new Error('cancelled'));
      },
      end() {},
    };
    const episode = await EpisodeClient.create(resolveConfig(), {
      kind: 'client',
      name: source.name,
      create: () => source,
    });
    try {
      const pending = episode.step().catch((error: Error) => error.message);
      while (!nextStarted) await new Promise((resolve) => setTimeout(resolve, 0));
      episode.finish('stopped', 'cancellation boundary check');
      await episode.settled();
      return {
        cancellations,
        error: await pending,
        outcome: episode.result.outcome,
        tick: episode.sim.ticks,
      };
    } finally {
      episode.dispose();
    }
  });
  assert.deepEqual(cancellation, {
    cancellations: 1,
    error: 'cancelled',
    outcome: 'stopped',
    tick: 0,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(physicsAssets, [], 'Browser must not load a Rapier WASM engine');
  await writeFile(
    await reportPath(
      'whole-body-browser.json',
      process.env.REPORT_DIR ? `${process.env.REPORT_DIR}/whole-body-browser.json` : undefined,
    ),
    JSON.stringify({ initial, optics, commandedOptics, cancellation, ...result, errors }, null, 2),
  );
  console.log(
    'Whole-body browser: both arms, moving head optics, viewport isolation, pause/resume and 16-axis settings passed',
  );
} finally {
  await host.close();
}
