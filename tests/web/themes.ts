import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
import { collect } from '../../src/runtime/runs/collect';
import { inspect } from '../../src/runtime/runs/inspect';
import { replay } from '../../src/runtime/recording/replay';
import { resolveConfig } from '../../src/runtime/config';
import { appearanceIdentity } from '../../src/runtime/appearance';
import { THEME_IDS } from '../../src/runtime/theme-catalog';
import { reportPath } from '../runtime/report-path';
const host = new BrowserHost();
try {
  await host.start();
  const page = await host.newPage();
  const result = await page.evaluate(async () => {
    const load = (name: string) => import(name);
    const THREE = await load('/node_modules/three/build/three.module.js');
    const { CAMERA_POSITIONS } = await load('/src/simulation/sensors/config.ts'),
      { resolveConfig } = await load('/src/runtime/config.ts');
    const { WorldClient: Simulation } = await load('/src/runtime/client/world-client.ts');
    const { worldConfig } = await load('/src/simulation/scene.ts');
    const { WorldScene } = await load('/src/runtime/browser/render/rendering.ts');
    const { SensorCamera } = await load('/src/runtime/browser/render/camera.ts');
    const { FramePipeline } = await load('/src/runtime/browser/frame-pipeline.ts');
    const { THEME_IDS } = await load('/src/runtime/theme-catalog.ts');
    const { appearanceIdentity } = await load('/src/runtime/appearance.ts');
    const config = resolveConfig({ camera: { depth: true } });
    const sim = await Simulation.create(worldConfig(config)),
      scene = new WorldScene(sim),
      sensor = new SensorCamera(scene, config.camera);
    const snapshot = JSON.stringify(sim.inspect()),
      meshIds = scene.robotMeshes.map((o: any) => o.uuid);
    const layoutReadonly =
      Object.isFrozen(scene.layout.robot) &&
      Object.isFrozen(scene.layout.robot.links) &&
      scene.layout.robot.links !== sim.config.environment.robot.links;
    const frames: number[][] = [],
      coverage = [];
    for (const theme of THEME_IDS) {
      scene.setTheme(theme);
      if (theme === 'studio') {
        const decorations = scene.theme.decorations.children;
        if (decorations.length !== 1 || decorations[0].geometry.type !== 'PlaneGeometry')
          throw new Error('Studio must contain only its ground plane outside the shared scene');
      }
      for (const position of CAMERA_POSITIONS) {
        sensor.rebind(scene, { ...config.camera, position });
        const frame = sensor.capture();
        if (position === 'SE') frames.push(Array.from(frame.rgb as Uint8Array));
        const points = [...sim.bodies, ...sim.arms[0].bodies]
          .map((body: any) => body.translation())
          .filter((p: any) => p.y >= config.environment.tableTop);
        const blocked = points.some((p: any) => {
          const target = new THREE.Vector3(p.x, p.y, p.z),
            origin = sensor.camera.position;
          const ray = new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
          return ray
            .intersectObject(scene.theme.decorations, true)
            .some((hit: any) => hit.distance < origin.distanceTo(target) - 0.005);
        });
        const body = scene.scene.getObjectByName('robot-body');
        let bodyBlocked = false;
        const [xmin, xmax, zmin, zmax] = config.scene.region;
        const samples = (lo: number, hi: number) =>
          Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
        for (const x of samples(xmin, xmax))
          for (const z of samples(zmin, zmax))
            for (const y of [
              config.environment.tableTop + 0.05,
              config.environment.tableTop + config.scene.maxStackHeight,
            ]) {
              const target = new THREE.Vector3(x, y, z),
                origin = sensor.camera.position;
              const ray = new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
              bodyBlocked ||= ray
                .intersectObject(body, true)
                .some((hit: any) => hit.distance < origin.distanceTo(target) - 0.005);
            }
        coverage.push({ theme, position, blocked, bodyBlocked, bytes: frame.rgb.length });
      }
    }
    sensor.rebind(scene, config.camera);
    const before = sensor.capture();
    scene.blocks[0].material.color.set('#000000');
    const after = sensor.capture();
    const materialDepth = before.depth.every((v: number, i: number) => v === after.depth[i]);
    const materialRgb = before.rgb.some((v: number, i: number) => v !== after.rgb[i]);
    const pipeline = new FramePipeline(
      sensor,
      { physicsHz: 120, observationHz: 10 },
      { png: true },
    );
    let captures = 0;
    const capture = sensor.captureAsync.bind(sensor);
    sensor.captureAsync = () => {
      captures++;
      return capture();
    };
    await pipeline.sample(0);
    await pipeline.sample(0);
    scene.setTheme('island');
    await pipeline.sample(0);
    pipeline.dispose();
    const unchanged =
      snapshot === JSON.stringify(sim.inspect()) &&
      meshIds.every((id: string, i: number) => id === scene.robotMeshes[i].uuid);
    const identities = THEME_IDS.map(appearanceIdentity);
    sensor.dispose();
    scene.dispose();
    await sim.dispose();
    return {
      identities,
      unchanged,
      layoutReadonly,
      materialDepth,
      materialRgb,
      captures,
      coverage,
      rgbChanges: frames.slice(1).every((frame) => frames[0].some((v, i) => v !== frame[i])),
    };
  });
  assert.deepEqual(result.identities, THEME_IDS.map(appearanceIdentity));
  assert(
    result.unchanged &&
      result.layoutReadonly &&
      result.materialDepth &&
      result.materialRgb &&
      result.rgbChanges,
  );
  assert.equal(result.captures, 2, 'same tick must be recaptured after a visual revision');
  assert(
    result.coverage.every((item: any) => !item.blocked && !item.bodyBlocked),
    JSON.stringify(result.coverage),
  );

  await page.addInitScript(() => localStorage.setItem('stackling.language', 'en'));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(host.url);
  await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
  const snapshots = await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    (window as any).themeOriginal = {
      sim: r.episode.sim,
      sensor: r.sensor,
      renderer: r.renderer,
      camera: r.camera,
    };
    return {
      world: r.episode.sim.inspect(),
      position: r.camera.position.toArray(),
      quaternion: r.camera.quaternion.toArray(),
    };
  });
  for (const theme of THEME_IDS) {
    await page.getByRole('combobox', { name: 'Theme', exact: true }).click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Island', 'Studio']);
    await page
      .getByRole('option', {
        name: { island: 'Island', studio: 'Studio' }[theme],
        exact: true,
      })
      .click();
    await page.waitForFunction(
      (theme) => (window as any).stacklingUI.scene.themeId === theme,
      theme,
    );
    await page.getByRole('option').first().waitFor({ state: 'hidden' });
    await page.screenshot({ path: await reportPath(`theme-${theme}.png`) });
  }
  const afterSwitch = await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    return {
      world: r.episode.sim.inspect(),
      position: r.camera.position.toArray(),
      quaternion: r.camera.quaternion.toArray(),
    };
  });
  assert.deepEqual(afterSwitch.world, snapshots.world);
  // OrbitControls recomputes spherical coordinates each frame, introducing roundoff.
  for (const key of ['position', 'quaternion'] as const)
    afterSwitch[key].forEach((value: number, i: number) =>
      assert(Math.abs(value - snapshots[key][i]) < 1e-12),
    );
  const memory: unknown[] = [];
  for (let i = 0; i < 33; i++) {
    const sample = await page.evaluate(
      (id) => {
        const r = (window as any).stacklingUI;
        if (!r.setTheme(id)) throw new Error('theme command rejected');
        r.scene.sync();
        r.scene.render(r.renderer, r.camera);
        r.sensor.capture();
        return [
          r.renderer.info.memory.geometries,
          r.renderer.info.memory.textures,
          r.sensor.renderer.info.memory.geometries,
          r.sensor.renderer.info.memory.textures,
        ];
      },
      THEME_IDS[i % THEME_IDS.length],
    );
    if (i >= THEME_IDS.length) memory.push(sample);
  }
  for (let i = THEME_IDS.length; i < memory.length; i++)
    assert.deepEqual(memory[i], memory[i % THEME_IDS.length]);
  assert(
    await page.evaluate(() => {
      const r = (window as any).stacklingUI,
        original = (window as any).themeOriginal;
      return (
        r.episode.sim === original.sim &&
        r.sensor === original.sensor &&
        r.renderer === original.renderer &&
        r.camera === original.camera
      );
    }),
  );
  assert(
    await page.evaluate(async () => {
      const { themes } = await import('/src/runtime/browser/render/themes.ts' as string);
      const { useUI } = await import('/src/app/web/store.ts' as string);
      const r = (window as any).stacklingUI,
        create = themes.studio.create;
      const original = r.scene.theme;
      themes.studio.create = () => {
        throw new Error('Injected theme construction failure');
      };
      try {
        return (
          !r.setTheme('studio') &&
          r.scene.theme === original &&
          r.config.appearance.theme === 'island'
        );
      } finally {
        themes.studio.create = create;
        useUI.setState({ error: '' });
      }
    }),
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert(await page.getByRole('combobox', { name: 'Theme', exact: true }).isDisabled());
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.setTheme('studio')), false);
  await page.getByRole('button', { name: 'Restore Defaults', exact: true }).click();
  await page.getByRole('button', { name: 'Apply & Reset', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  assert.equal(
    await page.evaluate(() => (window as any).stacklingUI.config.appearance.theme),
    'island',
  );
  await page.locator('#play').click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'running');
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.setTheme('island')), false);
  await page.locator('#play').click();
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.setTheme('island')), false);
  await page.locator('#play').click();
  // Finish the manual episode, then check that its recorded identity stays frozen.
  await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    r.episode.finish('stopped', 'test');
    r.setMode('finished');
  });
  await page.waitForFunction(() => !(window as any).stacklingUI.stepping);
  const finished = await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    const before = JSON.stringify([r.episode.config, r.episode.appearance, r.episode.result]);
    return (
      r.setTheme('studio') &&
      before === JSON.stringify([r.episode.config, r.episode.appearance, r.episode.result])
    );
  });
  assert(finished);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#language').click();
  assert(await page.getByRole('combobox', { name: '主题', exact: true }).isVisible());
  await page.screenshot({ path: await reportPath('theme-desktop-zh.png') });
  await page.close();
  await host.close();

  const root = path.resolve('.tmp', `theme-data-${Date.now()}`);
  const decodeHost = new BrowserHost();
  await decodeHost.start();
  const decodePage = await decodeHost.newPage();
  const videoChecks = [];
  try {
    for (const theme of THEME_IDS) {
      const config = resolveConfig({
        appearance: { theme },
        camera: { width: 64, heightPixels: 48, depth: true },
        run: { maxSeconds: 0.4 },
      });
      const out = path.join(root, theme);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(root, { recursive: true });
      await collect(config, { out, seeds: [42, 2026], workers: 1 });
      assert.equal((await inspect(out)).length, 2);
      await replay(path.join(out, 'episodes/000000'));
      const meta = JSON.parse(
        await readFile(path.join(out, 'episodes/000000/metadata.json'), 'utf8'),
      );
      assert.deepEqual(meta.appearance, appearanceIdentity(theme));
      assert.equal(meta.result.outcome, 'timeout');
      const bytes = Array.from(await readFile(path.join(out, 'episodes/000000/video.mp4')));
      const decoded = await decodePage.evaluate(
        async ({ bytes, config }) => {
          const load = (name: string) => import(name);
          const { WorldClient: Simulation } = await load('/src/runtime/client/world-client.ts');
          const { worldConfig } = await load('/src/simulation/scene.ts');
          const { WorldScene } = await load('/src/runtime/browser/render/rendering.ts');
          const { SensorCamera } = await load('/src/runtime/browser/render/camera.ts');
          const sim = await Simulation.create(worldConfig(config)),
            scene = new WorldScene(sim, config.appearance.theme),
            sensor = new SensorCamera(scene, config.camera);
          const expected = sensor.capture();
          const video = document.createElement('video');
          video.muted = true;
          Object.assign(video.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '999',
            width: '128px',
            height: '96px',
          });
          document.body.append(video);
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }));
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('Video decoding timed out')), 5000);
              video.onloadeddata = () => {
                clearTimeout(timer);
                resolve();
              };
              video.onerror = () => {
                clearTimeout(timer);
                reject(new Error(video.error?.message));
              };
              video.src = url;
              video.load();
            });
            const seek = (time: number) =>
              new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Video seek timed out')), 5000);
                video.onseeked = () => {
                  clearTimeout(timer);
                  resolve();
                };
                video.currentTime = time;
              });
            // Seek back to the first frame to populate the headless decode surface
            // without relying on playback in a background browser page.
            await seek(0.000001);
            await seek(0);
            const frame = { mediaTime: video.currentTime };
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext('2d')!;
            context.drawImage(video, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let error = 0;
            for (let i = 0; i < pixels.length; i++)
              if (i % 4 !== 3) error += Math.abs(pixels[i] - expected.rgb[i]);
            return {
              width: canvas.width,
              height: canvas.height,
              meanError: error / (canvas.width * canvas.height * 3),
              mediaTime: frame.mediaTime,
            };
          } finally {
            video.removeAttribute('src');
            video.load();
            video.remove();
            URL.revokeObjectURL(url);
            sensor.dispose();
            scene.dispose();
            await sim.dispose();
          }
        },
        { bytes, config },
      );
      assert.equal(decoded.width, 64);
      assert.equal(decoded.height, 48);
      assert.equal(decoded.mediaTime, 0, 'decode the initial observation frame');
      assert(decoded.meanError < 20, JSON.stringify({ theme, ...decoded }));
      videoChecks.push({ theme, ...decoded });
      const changed = resolveConfig(config, {
        appearance: { theme: THEME_IDS[(THEME_IDS.indexOf(theme) + 1) % THEME_IDS.length] },
      });
      await assert.rejects(
        collect(changed, { out, seeds: [42, 2026], workers: 1, resume: true }),
        /mismatch/,
      );
    }
  } finally {
    await decodeHost.close();
  }
  await writeFile(
    await reportPath('themes.json'),
    JSON.stringify({ result, memory, videoChecks, artifacts: root }, null, 2) + '\n',
  );
  console.log(
    'Themes: camera coverage, switching, resource disposal, immutable episodes, RGB-D, collection and replay passed',
  );
} finally {
  await host.close();
}
