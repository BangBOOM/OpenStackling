import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
import { collect } from '../../src/runtime/runs/collect';
import { inspect } from '../../src/runtime/runs/inspect';
import { replay } from '../../src/runtime/recording/replay';
import { resolveConfig } from '../../src/runtime/config';
import { calibration } from '../../src/simulation/sensors/camera';
import { reportPath } from '../runtime/report-path';

const host = new BrowserHost();
try {
  await host.start();
  const page = await host.newPage();
  const optics = await page.evaluate(async () => {
    const load = (p: string) => import(p);
    const THREE = await load('/node_modules/three/build/three.module.js');
    const { resolveConfig } = await load('/src/runtime/config.ts');
    const { WorldClient: Simulation } = await load('/src/runtime/client/world-client.ts');
    const { worldConfig } = await load('/src/simulation/scene.ts');
    const { WorldScene } = await load('/src/runtime/browser/render/rendering.ts');
    const { makeCamera, calibration } = await load('/src/simulation/sensors/camera.ts'),
      { SensorCamera } = await load('/src/runtime/browser/render/camera.ts');
    const rows = [];
    for (const pitch of [40, 55, 70]) {
      const config = resolveConfig({
        camera: { mount: 'head', head: { pitch, fov: 70, near: 0.02 }, depth: true },
      });
      const sim = await Simulation.create(worldConfig(config));
      const scene = new WorldScene(sim, 'island', pitch);
      const sensor = new SensorCamera(scene, config.camera);
      try {
        for (const theme of ['island', 'studio']) {
          scene.setTheme(theme);
          const frame = sensor.capture();
          const camera = sensor.camera;
          const ray = new THREE.Raycaster();
          // Project a known unobstructed table point; the optical center can see beyond the table.
          const tablePoint = new THREE.Vector3(0, config.environment.tableTop, 0).project(camera);
          const x = Math.floor(((tablePoint.x + 1) / 2) * 320),
            y = Math.floor(((1 - tablePoint.y) / 2) * 240);
          ray.setFromCamera(
            new THREE.Vector2(((x + 0.5) / 320) * 2 - 1, 1 - ((y + 0.5) / 240) * 2),
            camera,
          );
          const point = ray.ray.intersectPlane(
            new THREE.Plane(new THREE.Vector3(0, 1, 0), -config.environment.tableTop),
            new THREE.Vector3(),
          );
          const expected = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
          const index = (y * 320 + x) * 2;
          const actual = (frame.depth[index] + frame.depth[index + 1] * 256) / 1000;
          const lens = scene.scene.getObjectByName('head-camera-lens');
          const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(
            lens.getWorldQuaternion(new THREE.Quaternion()),
          );
          const delta = camera.position.clone().sub(lens.getWorldPosition(new THREE.Vector3()));
          rows.push({
            pitch,
            theme,
            depthError: Math.abs(actual - expected),
            actual,
            expected,
            opticalError: direction.distanceTo(camera.getWorldDirection(new THREE.Vector3())),
            lensOffset: delta.distanceTo(direction.clone().multiplyScalar(0.002)),
            calibrated:
              JSON.stringify(
                makeCamera(
                  config.camera,
                  config.environment,
                  sim.body.transform(),
                ).matrixWorld.toArray(),
              ) === JSON.stringify(camera.matrixWorld.toArray()),
            neutralCalibrated:
              JSON.stringify(calibration(config.camera, config.environment).cameraToWorld) ===
              JSON.stringify(makeCamera(config.camera, config.environment).matrixWorld.toArray()),
          });
        }
      } finally {
        sensor.dispose();
        scene.dispose();
        await sim.dispose();
      }
    }
    return rows;
  });
  for (const row of optics) {
    assert(
      row.calibrated && row.neutralCalibrated && row.opticalError < 1e-8 && row.lensOffset < 1e-8,
      JSON.stringify(row),
    );
    assert(row.depthError < 0.006, JSON.stringify(row));
  }
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.addInitScript(() => localStorage.setItem('stackling.language', 'zh'));
  await page.goto(host.url);
  await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const original = await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    (window as any).originalHeadTest = { episode: r.episode, rgb: r.sensor.capture().rgb };
    return {
      config: r.config,
      camera: r.camera.position.toArray(),
      target: r.orbit.target.toArray(),
    };
  });
  await page.getByRole('button', { name: '切换到第一人称', exact: true }).click();
  await page.waitForTimeout(200);
  assert(
    await page.evaluate(() => {
      const r = (window as any).stacklingUI,
        old = (window as any).originalHeadTest;
      const frame = r.sensor.capture();
      return (
        old.episode === r.episode &&
        old.rgb.every((v: number, i: number) => v === frame.rgb[i]) &&
        !r.orbit.enabled
      );
    }),
  );
  await page.getByRole('button', { name: '切换到全景', exact: true }).click();
  assert.deepEqual(
    await page.evaluate(() => {
      const r = (window as any).stacklingUI;
      return { camera: r.camera.position.toArray(), target: r.orbit.target.toArray() };
    }),
    { camera: original.camera, target: original.target },
  );
  const openCamera = async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '相机', exact: true }).click();
  };
  const selectHead = async () => {
    await page.getByRole('combobox', { name: '采集相机', exact: true }).click();
    await page.getByRole('option', { name: '头部相机', exact: true }).click();
    await page.waitForFunction(() => (window as any).stacklingUI.sensor.config.mount === 'head');
  };
  await openCamera();
  await selectHead();
  assert.equal(await page.getByLabel('距离 · m', { exact: true }).count(), 0);
  await page
    .getByLabel('主画面视角', { exact: true })
    .getByText('第一人称', { exact: true })
    .click();
  await page.getByLabel('镜头俯角 · °', { exact: true }).fill('60');
  await page.waitForFunction(() => (window as any).stacklingUI.scene.headPitch === 60);
  await page.getByLabel('镜头俯角 · °', { exact: true }).fill('90');
  assert(await page.getByRole('button', { name: '应用并重置', exact: true }).isDisabled());
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  assert.deepEqual(await page.evaluate(() => (window as any).stacklingUI.config), original.config);
  assert(
    await page.evaluate(async () => {
      const { useUI } = await import('/src/app/web/store.ts' as string);
      const r = (window as any).stacklingUI;
      return (
        r.episode === (window as any).originalHeadTest.episode &&
        useUI.getState().viewport === 'orbit' &&
        r.scene.headPitch === 55
      );
    }),
  );
  await openCamera();
  await selectHead();
  await page
    .getByLabel('主画面视角', { exact: true })
    .getByText('第一人称', { exact: true })
    .click();
  await page.getByRole('switch', { name: '深度采集', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.sensor.config.depth);
  await page.evaluate(() => (window as any).stacklingUI.updateSceneSeed(42));
  await page.mouse.move(800, 80);
  await page.waitForTimeout(200);
  await page.screenshot({ path: await reportPath('head-camera-settings.png') });
  await page.locator('#language').click();
  assert(await page.getByRole('combobox', { name: 'Capture camera', exact: true }).isVisible());
  await page.locator('#language').click();
  await page.getByRole('button', { name: '应用并重置', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.config.camera.mount), 'head');
  await page.mouse.move(800, 80);
  await page.waitForTimeout(200);
  await page.screenshot({ path: await reportPath('head-camera-view.png') });
  await page.getByRole('tab', { name: '深度', exact: true }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: await reportPath('head-camera-depth.png') });
  await page.getByRole('tab', { name: 'RGB', exact: true }).click();
  await page.getByRole('button', { name: '自动堆叠', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.episode.phase === 'carry', null, {
    timeout: 30000,
  });
  await page.locator('#play').click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'paused');
  await page.mouse.move(800, 80);
  await page.waitForTimeout(200);
  await page.screenshot({ path: await reportPath('head-camera-working.png') });
  await openCamera();
  assert(await page.getByRole('combobox', { name: '采集相机', exact: true }).isDisabled());
  assert.equal(
    await page.evaluate(() =>
      (window as any).stacklingUI.updateDraft({ camera: { mount: 'external' } }),
    ),
    false,
  );
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByRole('button', { name: '切换到全景', exact: true }).click();
  assert.equal(
    await page.evaluate(() => (window as any).stacklingUI.episode.config.camera.mount),
    'head',
  );
  await page.locator('#play').click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'finished', null, {
    timeout: 30000,
  });
  const result = await page.evaluate(() => (window as any).stacklingUI.episode.result);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(errors, []);
  await host.closePage(page);
  await host.close();

  const config = resolveConfig({
    camera: { mount: 'head', width: 64, heightPixels: 48, depth: true },
    run: { maxSeconds: 0.4 },
  });
  const out = path.resolve('.tmp', `head-data-${Date.now()}`);
  await collect(config, { out, seeds: [42], workers: 1 });
  assert.equal((await inspect(out)).length, 1);
  const replayed = await replay(path.join(out, 'episodes/000000'));
  const meta = JSON.parse(await readFile(path.join(out, 'episodes/000000/metadata.json'), 'utf8'));
  assert.deepEqual(meta.calibration, calibration(config.camera, config.environment));
  assert.equal(meta.config.camera.mount, 'head');
  assert.equal(meta.result.outcome, 'timeout');
  await assert.rejects(
    collect(resolveConfig(config, { camera: { mount: 'external' } }), {
      out,
      seeds: [42],
      workers: 1,
      resume: true,
    }),
    /mismatch/,
  );
  await writeFile(
    await reportPath('head-camera.json'),
    JSON.stringify(
      { optics, result, errors, recording: { out, calibration: meta.calibration, replayed } },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Head camera: optical pose, RGB-D, view isolation, settings apply/cancel, bilingual UI, teacher and recording/replay passed',
  );
} finally {
  await host.close();
}
