import { reportPath } from '../runtime/report-path';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
const host = new BrowserHost();
try {
  await host.start();
  const page = await host.newPage();
  const results = await page.evaluate(async () => {
    const load = async (p: string) => import(p),
      THREE = await load('/node_modules/three/build/three.module.js');
    const { CAMERA_POSITIONS } = await load('/src/simulation/sensors/config.ts'),
      { resolveConfig } = await load('/src/runtime/config.ts'),
      { WorldClient: Simulation } = await load('/src/runtime/client/world-client.ts'),
      { worldConfig } = await load('/src/simulation/scene.ts'),
      { WorldScene } = await load('/src/runtime/browser/render/rendering.ts'),
      { makeCamera, calibration } = await load('/src/simulation/sensors/camera.ts'),
      { SensorCamera } = await load('/src/runtime/browser/render/camera.ts'),
      { flipRows, unpackDepth } = await load('/src/runtime/browser/render/pixels.ts'),
      { FramePipeline } = await load('/src/runtime/browser/frame-pipeline.ts');
    const coverage = [];
    for (const position of CAMERA_POSITIONS) {
      const c = resolveConfig({ camera: { position } }),
        camera = makeCamera(c.camera, c.environment);
      let covered = true;
      for (const x of [-c.environment.tableSize / 2, c.environment.tableSize / 2])
        for (const z of [-c.environment.tableDepth / 2, c.environment.tableDepth / 2])
          for (const y of [
            c.environment.tableTop,
            c.environment.tableTop + c.scene.maxStackHeight,
          ]) {
            const p = new THREE.Vector3(x, y, z).project(camera);
            if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || Math.abs(p.z) > 1) covered = false;
          }
      coverage.push({ position, covered });
    }
    const c = resolveConfig({ camera: { depth: true } }),
      sim = await Simulation.create(worldConfig(c)),
      scene = new WorldScene(sim),
      sensor = new SensorCamera(scene, c.camera);
    const first = sensor.capture(),
      second = sensor.capture();
    const identical = first.rgb.every((v: number, i: number) => v === second.rgb[i]);
    // The async path must produce the same bytes as the synchronous one, and an
    // in-flight readback must keep the tick it was issued at even if the scene
    // changes and the render target is reused before the fence resolves.
    const pending = await sensor.captureAsync(),
      pendingRgb = flipRows(pending.rgba, c.camera.width, c.camera.heightPixels),
      pendingDepth = unpackDepth(pending.depthRgba!, c.camera.width, c.camera.heightPixels),
      asyncIdentical =
        first.rgb.every((v: number, i: number) => v === pendingRgb[i]) &&
        first.depth!.every((v: number, i: number) => v === pendingDepth[i]);
    const issued = sensor.captureAsync();
    scene.scene.background = new THREE.Color(0x000000);
    const after = sensor.capture(),
      before = await issued,
      beforeRgb = flipRows(before.rgba, c.camera.width, c.camera.heightPixels),
      asyncIsolation =
        beforeRgb.every((v: number, i: number) => v === first.rgb[i]) &&
        after.rgb.some((v: number, i: number) => v !== first.rgb[i]);
    // Readback fences resolve out of order; the encoder must still see ticks in
    // order, otherwise video timestamps and keyframe placement break.
    const pipeline = new FramePipeline(
        sensor,
        { physicsHz: c.environment.physicsHz, observationHz: c.run.observationHz },
        { video: false, png: false },
      ),
      ticks: number[] = [],
      encode = pipeline.encoder.encode.bind(pipeline.encoder);
    pipeline.encoder.encode = ((...args: unknown[]) => {
      ticks.push(args[0] as number);
      return encode(...(args as Parameters<typeof encode>));
    }) as typeof encode;
    const samples: Promise<unknown>[] = [pipeline.sample(sim.ticks)];
    for (let i = 0; i < 30; i++) {
      for (let k = 0; k < c.environment.physicsHz / c.run.observationHz; k++) await sim.step();
      samples.push(pipeline.sample(sim.ticks));
    }
    await Promise.all(samples);
    const tickOrder = ticks.every((v, i) => i === 0 || v > ticks[i - 1]);
    pipeline.dispose();
    // Replace the articulated scene with a static optical calibration fixture.
    scene.sync = () => {};
    scene.scene.clear();
    scene.scene.background = new THREE.Color(0x000000);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xff0000, toneMapped: false }),
    );
    plane.quaternion.copy(sensor.camera.quaternion);
    plane.position
      .copy(sensor.camera.position)
      .add(sensor.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(2));
    scene.scene.add(plane);
    const reference = sensor.capture(),
      i = Math.floor(c.camera.heightPixels / 2) * c.camera.width + Math.floor(c.camera.width / 2),
      depth = reference.depth[i * 2] + reference.depth[i * 2 + 1] * 256;
    const rgb = Array.from(reference.rgb.slice(i * 4, i * 4 + 4)) as number[],
      corner = reference.depth[0] + reference.depth[1] * 256;
    plane.geometry.dispose();
    plane.material.dispose();
    sensor.dispose();
    scene.dispose();
    await sim.dispose();
    return {
      coverage,
      identical,
      asyncIdentical,
      asyncIsolation,
      tickOrder,
      depth,
      rgb,
      corner,
      calibration: calibration(c.camera, c.environment),
    };
  });
  assert(
    results.coverage.every((r: any) => r.covered),
    JSON.stringify(results.coverage),
  );
  assert(results.identical);
  assert(results.asyncIdentical, 'captureAsync bytes differ from capture');
  assert(results.asyncIsolation, 'in-flight readback did not keep its tick snapshot');
  assert(results.tickOrder, 'encoder received frames out of tick order');
  assert(Math.abs(results.depth - 2000) <= 2, `depth ${results.depth}`);
  assert(results.rgb[0] > 240 && results.rgb[1] < 5 && results.rgb[2] < 5);
  assert.equal(results.corner, 0);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('stackling.language', 'zh'));
  await page.goto(host.url);
  await page.waitForFunction(() => Boolean((window as any).stacklingUI));

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole('dialog', { name: '设置' }).count(), 0);
  const viewState = () =>
    page.evaluate(() => {
      const runtime = (window as any).stacklingUI;
      return {
        bounds: runtime.renderer.domElement.getBoundingClientRect().toJSON(),
        width: runtime.renderer.domElement.width,
        height: runtime.renderer.domElement.height,
        position: runtime.camera.position.toArray(),
        quaternion: runtime.camera.quaternion.toArray(),
        projection: runtime.camera.projectionMatrix.toArray(),
      };
    });
  const closedView = await viewState();
  await page.screenshot({ path: await reportPath('ui-island.png') });
  await page.evaluate(() => {
    (window as any).originalEpisode = (window as any).stacklingUI.episode;
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('dialog', { name: '设置' }).waitFor();
  await page.waitForTimeout(200);
  assert.deepEqual(
    await viewState(),
    closedView,
    'Opening settings must preserve canvas and camera',
  );
  const card = await page.getByRole('dialog', { name: '设置' }).boundingBox();
  assert(
    card && card.x > 0 && card.y > 52 && card.x + card.width < 1440 && card.y + card.height < 960,
  );
  await page.locator('#viewport > canvas').click({ position: { x: 30, y: 30 } });
  assert(
    await page.getByRole('dialog', { name: '设置' }).isVisible(),
    'Scene remains interactive without dismissing settings',
  );
  await page.screenshot({ path: await reportPath('ui-settings.png') });
  await page.getByRole('tab', { name: '相机', exact: true }).click();
  await page.locator('[data-camera="NW"]').click();
  await page.waitForFunction(() => (window as any).stacklingUI.sensor.config.position === 'NW');
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.config.camera.position), 'SE');
  await page.getByRole('button', { name: '应用并重置' }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.config.camera.position === 'NW');
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'hidden' });
  assert.deepEqual(
    await viewState(),
    closedView,
    'Closing settings must preserve canvas and camera',
  );
  const isolated = await page.evaluate(async () => {
    const runtime = (window as any).stacklingUI;
    const before = runtime.sensor.capture();
    const { useUI } = await import('/src/app/web/store.ts' as string);
    useUI.setState({ markers: false, annotations: true });
    runtime.orbit.rotateSpeed = 1.1;
    runtime.camera.position.x += 0.1;
    runtime.orbit.update();
    runtime.scene.render(runtime.renderer, runtime.camera);
    const after = runtime.sensor.capture();
    useUI.setState({ markers: true, annotations: false });
    return before.rgb.every((v: number, i: number) => v === after.rgb[i]);
  });
  assert(isolated, 'UI overlays and main camera must not change sensor pixels');
  await page.evaluate(() => {
    (window as any).originalEpisode = (window as any).stacklingUI.episode;
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('场景种子', { exact: true }).focus();
  await page.keyboard.press('w');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.episode.sim.time), 0);
  await page.getByRole('button', { name: '关闭设置' }).click();
  assert(
    await page.evaluate(
      () => (window as any).originalEpisode === (window as any).stacklingUI.episode,
    ),
    'Settings toggles must preserve the episode',
  );
  await page.locator('#teacher').click();
  await page.waitForFunction(() => (window as any).stacklingUI.episode.sim.time > 1);
  await page.locator('#play').click();
  await page.evaluate(() => (window as any).stacklingUI.episode.settled());
  const time = await page.evaluate(() => (window as any).stacklingUI.episode.sim.time);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.episode.sim.time), time);
  // A completed teacher run still uses the common runner and independent scorer.
  await page.locator('#play').click();
  await page.waitForFunction(() => Boolean((window as any).stacklingUI.episode.result), undefined, {
    timeout: 60_000,
  });
  const outcome = await page.evaluate(() => (window as any).stacklingUI.episode.result.outcome);
  assert.equal(outcome, 'success');
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.episode.sim.time === 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: await reportPath('ui-mobile.png') });
  assert(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth));
  const mobileView = await viewState();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '设置', exact: true });
  await sheet.waitFor();
  await page.waitForTimeout(200);
  assert.deepEqual(await viewState(), mobileView);
  const mobileCard = await sheet.boundingBox();
  assert(
    mobileCard &&
      mobileCard.x > 0 &&
      mobileCard.y > 52 &&
      mobileCard.x + mobileCard.width < 390 &&
      mobileCard.y + mobileCard.height < 844,
  );
  await page.getByRole('tab', { name: '相机', exact: true }).click();
  await page.getByRole('switch', { name: '深度采集' }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.sensor.config.depth);
  await page.screenshot({ path: await reportPath('ui-mobile-settings.png') });
  await page.getByRole('button', { name: '应用并重置' }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.config.camera.depth);
  await sheet.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: '深度', exact: true }).click();
  await page.getByRole('button', { name: '放大预览' }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('[data-sensor-preview] canvas').count(), 1);
  await page.getByRole('button', { name: '缩小预览' }).click();
  assert.deepEqual(errors, []);
  await writeFile(
    await reportPath('browser-island.json'),
    JSON.stringify(
      {
        ...results,
        ui: {
          settingsPreserveEpisode: true,
          settingsPreserveViewport: true,
          floatingCard: true,
          sensorIsolation: isolated,
          teacherOutcome: outcome,
          mobile: true,
          depthPreview: true,
        },
      },
      null,
      2,
    ),
  );
  console.log(
    'browser: eight cameras, metric depth, sensor isolation, settings, teacher, pause, mobile and depth preview passed',
  );
} finally {
  await host.close();
}
