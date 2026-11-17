import assert from 'node:assert/strict';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
const host = new BrowserHost();
try {
  await host.start();
  const page = await host.newPage(),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('stackling.language', 'zh'));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(host.url);
  await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
  const mode = () => page.evaluate(() => (window as any).stacklingUI.mode);
  const time = () => page.evaluate(() => (window as any).stacklingUI.episode.sim.time);
  const snapshot = () => page.evaluate(() => (window as any).stacklingUI.episode.sim.inspect());
  const seed = () => page.evaluate(() => (window as any).stacklingUI.config.run.seed);
  const settings = page.getByRole('button', { name: '设置', exact: true });
  const apply = page.getByRole('button', { name: '应用并重置' });
  const card = page.getByRole('dialog', { name: '设置', exact: true });
  const reset = page.getByRole('button', { name: '重置', exact: true });
  const play = page.locator('#play');
  const teacher = page.locator('#teacher');
  const rate = page.getByRole('combobox', { name: '自动堆叠倍速' });
  const waitMode = (expected: string) =>
    page.waitForFunction((mode) => (window as any).stacklingUI.mode === mode, expected);
  const close = async () => {
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'hidden' });
  };

  // Draft preview, commit, cancel and restore defaults.
  await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    (window as any).original = {
      episode: r.episode,
      snapshot: r.episode.sim.inspect(),
      config: structuredClone(r.config),
    };
  });
  await settings.click();
  assert.equal(await mode(), 'editing');
  assert(await play.isDisabled());
  assert(await teacher.isDisabled());
  assert(await reset.isDisabled());
  assert.deepEqual(
    await page.evaluate(async () => {
      const r = (window as any).stacklingUI;
      return [await r.toggle(), r.teacher(), r.request(), await r.shuffle()];
    }),
    [false, false, false, false],
  );
  await page.locator('#viewport > canvas').click({ position: { x: 20, y: 20 } });
  await page.keyboard.down('w');
  await page.waitForTimeout(180);
  await page.keyboard.up('w');
  assert.equal(await time(), 0);
  await page.getByRole('tab', { name: '相机', exact: true }).click();
  await page.evaluate(() => {
    (window as any).previewEpisode = (window as any).stacklingUI.episode;
  });
  await page.locator('[data-camera="N"]').click();
  await page.waitForFunction(() => (window as any).stacklingUI.sensor.config.position === 'N');
  assert(
    await page.evaluate(() => {
      const r = (window as any).stacklingUI;
      return r.episode !== (window as any).previewEpisode && r.config.camera.position === 'SE';
    }),
  );
  await page.evaluate(() => {
    (window as any).previewEpisode = (window as any).stacklingUI.episode;
  });
  await page.getByLabel('宽 · px', { exact: true }).fill('400');
  await page.waitForFunction(() => (window as any).stacklingUI.sensor.config.width === 400);
  assert(
    await page.evaluate(
      () => (window as any).stacklingUI.episode === (window as any).previewEpisode,
    ),
  );
  await page.getByLabel('视野角度 · °', { exact: true }).fill('180');
  assert(await apply.isDisabled());
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.sensor.config.fov), 60);
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.applyEdit()), false);
  await page.getByLabel('视野角度 · °', { exact: true }).fill('55');
  await page.waitForFunction(() => (window as any).stacklingUI.sensor.config.fov === 55);
  await page.getByRole('tab', { name: '环境', exact: true }).click();
  await page.getByLabel('积木数量', { exact: true }).fill('5');
  await page.waitForFunction(() => (window as any).stacklingUI.episode.sim.blockCount === 5);
  await page.getByLabel('场景种子', { exact: true }).fill('2026');
  await page.waitForFunction(() => (window as any).stacklingUI.episode.config.run.seed === 2026);
  assert.equal(await time(), 0);
  // Failed sampling must keep the last valid preview and the applied configuration.
  const preview = await page.evaluate(() => (window as any).stacklingUI.episode.sim.inspect());
  await page.evaluate(() =>
    (window as any).stacklingUI.updateDraft({
      scene: { region: [-0.01, 0.01, -0.01, 0.01], maxAttempts: 2 },
    }),
  );
  await page.waitForFunction(async () => {
    const { useUI } = await import('/src/app/web/store.ts' as string);
    return !!useUI.getState().draftError;
  });
  assert.deepEqual(await snapshot(), preview);
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.applyEdit()), false);
  await close();
  assert.equal(await mode(), 'idle');
  assert(
    await page.evaluate(() => {
      const r = (window as any).stacklingUI,
        o = (window as any).original;
      return (
        r.episode === o.episode &&
        JSON.stringify(r.config) === JSON.stringify(o.config) &&
        JSON.stringify(r.episode.sim.inspect()) === JSON.stringify(o.snapshot)
      );
    }),
  );
  // Cancel also drops preview work queued within the same event turn.
  assert(
    await page.evaluate(async () => {
      const r = (window as any).stacklingUI;
      await r.beginEdit();
      r.updateDraft({ run: { seed: 7 } });
      r.cancelEdit();
      return r.mode === 'idle' && r.config.run.seed === 42;
    }),
  );
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.episode.config.run.seed), 42);
  await settings.click();
  await page.getByLabel('场景种子', { exact: true }).fill('2026');
  await page.getByLabel('积木数量', { exact: true }).fill('5');
  await page.waitForFunction(() => (window as any).stacklingUI.episode.sim.blockCount === 5);
  await apply.click();
  await waitMode('idle');
  await card.waitFor({ state: 'hidden' });
  assert.equal(await mode(), 'idle');
  assert.equal(await time(), 0);
  assert.deepEqual(
    await page.evaluate(() => {
      const r = (window as any).stacklingUI;
      return [r.config.run.seed, r.config.scene.objects.length, r.config.run.maxSeconds];
    }),
    [2026, 5, 240],
  );
  // Manual run, pause, resume, reset: settings can be viewed but edits stay locked.
  await page.locator('#viewport > canvas').click({ position: { x: 20, y: 20 } });
  await page.keyboard.down('w');
  await waitMode('running');
  await page.keyboard.up('w');
  assert(await settings.isEnabled());
  assert(await teacher.isDisabled());
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.beginEdit()), false);
  await play.click();
  assert.equal(await mode(), 'paused');
  await page.evaluate(() => (window as any).stacklingUI.episode.settled());
  const paused = await time();
  await page.keyboard.press('w');
  await page.waitForTimeout(150);
  assert.equal(await time(), paused);
  assert(await settings.isEnabled());
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.beginEdit()), false);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.waitForFunction((t) => (window as any).stacklingUI.episode.sim.time > t, paused);
  await reset.click();
  await waitMode('idle');
  assert.equal(await time(), 0);
  // Defaults are a reversible draft, even when the form currently contains invalid input.
  await settings.click();
  await page.getByRole('switch', { name: '关节刻度' }).click();
  const appliedAnnotations = await page
    .getByRole('switch', { name: '关节刻度' })
    .getAttribute('aria-checked');
  await apply.click();
  await waitMode('idle');
  await card.waitFor({ state: 'hidden' });
  await settings.click();
  await page.getByRole('tab', { name: '相机', exact: true }).click();
  await page.getByLabel('视野角度 · °', { exact: true }).fill('180');
  assert(await apply.isDisabled());
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.episode.sim.blockCount === 2);
  assert.equal(await mode(), 'editing');
  assert(await apply.isEnabled());
  assert.equal(await page.getByLabel('视野角度 · °', { exact: true }).inputValue(), '60');
  assert.deepEqual(
    await page.evaluate(() => {
      const r = (window as any).stacklingUI;
      return [r.config.scene.objects.length, r.config.run.seed];
    }),
    [5, 2026],
  );
  await page.keyboard.press('Escape');
  await card.waitFor({ state: 'hidden' });
  await settings.click();
  assert.equal(
    await page.getByRole('switch', { name: '关节刻度' }).getAttribute('aria-checked'),
    appliedAnnotations,
  );
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await apply.click();
  await waitMode('idle');
  await card.waitFor({ state: 'hidden' });
  assert.equal(await mode(), 'idle');
  console.log(
    'UI: draft preview, commit, cancel, restore defaults and execution interlocks passed',
  );

  // Scene seed rules: apply, cancel, invalid input, regeneration and the displayed seed.
  await page.evaluate(() => {
    const r = (window as any).stacklingUI,
      c = structuredClone(r.config);
    c.run.seed = 42;
    r.request(c);
  });
  await waitMode('idle');
  const initial = await snapshot();
  const generate = page.getByRole('button', { name: '生成场景', exact: true });
  await settings.click();
  await page.getByRole('tab', { name: '环境', exact: true }).click();
  assert.equal(await page.locator('#scene-seed').inputValue(), '');
  await page.locator('#scene-seed').fill('2026');
  await close();
  assert.deepEqual(await snapshot(), initial);
  await settings.click();
  await page.locator('#scene-seed').fill('2026');
  await apply.click();
  await waitMode('idle');
  assert.equal(await seed(), 2026);
  const fixed = await snapshot();
  await generate.click();
  await waitMode('idle');
  assert.deepEqual(await snapshot(), fixed);
  await card.waitFor({ state: 'hidden' });
  await settings.click();
  await page.locator('#scene-seed').fill('-1');
  assert(await apply.isDisabled());
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.applyEdit()), false);
  await close();
  assert.deepEqual(await snapshot(), fixed);
  await generate.click();
  await waitMode('idle');
  assert.equal(await seed(), 2026);
  // Make RNG outputs deterministic to check each explicit generation, not chance.
  await page.evaluate(() => {
    const original = crypto.getRandomValues.bind(crypto);
    (window as any).restoreRandom = () => {
      crypto.getRandomValues = original;
    };
    let next = 1000;
    crypto.getRandomValues = ((array: Uint32Array) => {
      array[0] = next++;
      return array;
    }) as any;
  });
  await settings.click();
  await page.locator('#scene-seed').fill('');
  await apply.click();
  await waitMode('idle');
  assert.equal(await seed(), 1000);
  await generate.click();
  await waitMode('idle');
  assert.equal(await seed(), 1001);
  await generate.click();
  await waitMode('idle');
  assert.equal(await seed(), 1002);
  await page.evaluate(() => (window as any).restoreRandom());
  await settings.click();
  assert.equal(await page.locator('#scene-seed').inputValue(), '');
  assert.equal(await page.locator('[data-scene-seed]').innerText(), '1002');
  await page.locator('#scene-seed').fill('42');
  await apply.click();
  await waitMode('idle');
  assert.deepEqual(await snapshot(), initial);
  console.log('UI: scene seed drafts, deterministic and random generation passed');

  // Rate selector interlocks and fixed-step pacing.
  assert.equal(await rate.innerText(), '1×');
  await rate.click();
  await page.getByRole('option', { name: '5×', exact: true }).click();
  assert.equal(await rate.innerText(), '5×');
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.setTeacherRate(3)), false);
  await settings.click();
  assert(await rate.isDisabled());
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.setTeacherRate(2)), false);
  await close();
  await play.click();
  assert(await rate.isDisabled());
  await play.click();
  assert(await rate.isDisabled());
  await reset.click();
  await waitMode('idle');
  await teacher.click();
  await waitMode('running');
  assert(await rate.isEnabled());
  await rate.click();
  await page.getByRole('option', { name: '2×', exact: true }).click();
  await play.click();
  await page.evaluate(() => (window as any).stacklingUI.episode.settled());
  const pausedTicks = await page.evaluate(() => (window as any).stacklingUI.episode.sim.ticks);
  await rate.click();
  await page.getByRole('option', { name: '5×', exact: true }).click();
  assert.equal(
    await page.evaluate(() => (window as any).stacklingUI.episode.sim.ticks),
    pausedTicks,
  );
  await page.getByRole('button', { name: '继续', exact: true }).click();
  assert.equal(await rate.innerText(), '5×');
  await page.getByRole('button', { name: '停止堆叠' }).click();
  assert(await rate.isEnabled());
  // Drive actual RAF callbacks with equal elapsed intervals, avoiding wall-clock timing assertions.
  // Physics, teacher, renderer and Episode are real; only RAF scheduling is controlled here.
  // Extra frames with zero elapsed time drain work deferred by the per-frame CPU budget.
  const pacing = await page.evaluate(async () => {
    const r = (window as any).stacklingUI,
      realRAF = window.requestAnimationFrame;
    window.cancelAnimationFrame(r.raf);
    window.requestAnimationFrame = () => 0;
    let now = r.last;
    const samples = [];
    const frame = async () => {
      do {
        await r.frame(now);
        await r.stepping;
      } while (r.mode === 'running' && r.accumulator >= r.episode.sim.dt);
    };
    const reset = async () => {
      r.request();
      await r.stepping;
      await frame();
      r.last = now;
    };
    try {
      for (const speed of [1, 2, 5]) {
        await reset();
        r.setTeacherRate(speed);
        r.teacher();
        await frame();
        r.last = now;
        for (let i = 0; i < 200 / speed; i++) {
          now += 10.000001;
          await frame();
        }
        samples.push({
          speed,
          ticks: r.episode.sim.ticks,
          dt: r.episode.sim.dt,
          actions: r.episode.actions,
          observations: r.episode.observations,
          controlHz: r.config.run.controlHz,
          observationHz: r.config.run.observationHz,
          snapshot: r.episode.sim.inspect(),
        });
      }
      await reset();
      r.setTeacherRate(1);
      r.teacher();
      await frame();
      r.last = now;
      now += 1000.000001;
      await frame();
      const delayedTicks = r.episode.sim.ticks;
      now += 1000.000001;
      await frame();
      const delayedSnapshot = r.episode.sim.inspect();
      await reset();
      r.setTeacherRate(5);
      await r.toggle();
      r.last = now;
      for (let i = 0; i < 200; i++) {
        now += 10.000001;
        await frame();
      }
      return { samples, manualTicks: r.episode.sim.ticks, delayedTicks, delayedSnapshot };
    } finally {
      if (r.mode === 'running') await r.toggle();
      r.last = performance.now();
      r.lastTelemetry = -Infinity;
      r.lastCapture = -Infinity;
      window.requestAnimationFrame = realRAF;
      r.raf = window.requestAnimationFrame(r.frame);
    }
  });
  assert.equal(
    pacing.delayedTicks,
    120,
    'A delayed teacher frame must retain every due fixed step',
  );
  assert.deepEqual(pacing.delayedSnapshot, pacing.samples[0].snapshot);
  for (const sample of pacing.samples) {
    assert.equal(sample.ticks, 240);
    assert.equal(sample.dt, 1 / 120);
    assert.equal(sample.actions, 2 * sample.controlHz);
    assert.equal(sample.observations, 2 * sample.observationHz);
    assert.deepEqual(sample.snapshot, pacing.samples[0].snapshot);
  }
  assert.equal(pacing.manualTicks, 240, 'Manual control must remain at 1× with 5× selected');
  await reset.click();
  await waitMode('idle');
  console.log('UI: rate interlocks and fixed-step pacing passed');

  // Restart rules for stopped, timed-out and successful episodes.
  async function checkFinished(outcome: string) {
    await waitMode('finished');
    await page.evaluate(() => (window as any).stacklingUI.episode.settled());
    assert(await play.isEnabled());
    assert(await teacher.isEnabled());
    assert(await rate.isEnabled());
    assert(await settings.isEnabled());
    const finished = await page.evaluate(() => {
      const r = (window as any).stacklingUI;
      (window as any).endedEpisode = r.episode;
      (window as any).endedConfig = structuredClone(r.config);
      return r.episode.sim.inspect();
    });
    assert.equal(
      await page.evaluate(() => (window as any).stacklingUI.episode.result.outcome),
      outcome,
    );
    await page.waitForTimeout(150);
    assert.deepEqual(await snapshot(), finished);
  }
  async function checkRestart(source: string) {
    await waitMode('running');
    assert(
      await page.evaluate((source) => {
        const r = (window as any).stacklingUI;
        return (
          r.episode !== (window as any).endedEpisode &&
          !r.episode.result &&
          (r.episode.source.actions?.name ?? r.episode.source.kind) === source &&
          JSON.stringify(r.config) === JSON.stringify((window as any).endedConfig)
        );
      }, source),
    );
  }
  await rate.click();
  await page.getByRole('option', { name: '5×', exact: true }).click();
  await teacher.click();
  await waitMode('running');
  await page.waitForFunction(() => (window as any).stacklingUI.episode.sim.time > 1);
  await teacher.click();
  await checkFinished('stopped');
  await teacher.click();
  await checkRestart('teacher');
  assert.equal(await rate.innerText(), '5×');
  await teacher.click();
  await checkFinished('stopped');
  await play.click();
  await checkRestart('manual');
  await play.click();
  await waitMode('paused');
  await page.evaluate(() => {
    (window as any).pausedEpisode = (window as any).stacklingUI.episode;
  });
  await play.click();
  await waitMode('running');
  assert(
    await page.evaluate(
      () => (window as any).stacklingUI.episode === (window as any).pausedEpisode,
    ),
  );
  await reset.click();
  await waitMode('idle');
  await page.evaluate(() => {
    const r = (window as any).stacklingUI,
      c = structuredClone(r.config);
    c.run.seed = 2026;
    c.run.maxSeconds = 1;
    r.request(c);
  });
  await waitMode('idle');
  await play.click();
  await checkFinished('timeout');
  await play.click();
  await checkRestart('manual');
  await reset.click();
  await waitMode('idle');
  await page.evaluate(() => {
    const r = (window as any).stacklingUI,
      c = structuredClone(r.config);
    c.run.maxSeconds = 120;
    r.request(c);
  });
  await waitMode('idle');
  await teacher.click();
  await checkFinished('success');
  // A second start in the reset transition must not schedule a duplicate episode.
  assert.deepEqual(
    await page.evaluate(async () => {
      const r = (window as any).stacklingUI;
      return [r.teacher(), await r.toggle(), r.teacher(), r.mode];
    }),
    [true, false, false, 'resetting'],
  );
  await checkRestart('teacher');
  assert.equal(await seed(), 2026);
  await reset.click();
  await waitMode('idle');
  console.log('UI: restart rules for stopped, timed-out and successful tasks passed');

  // Panel mutual exclusion, keyboard isolation and uninterrupted teacher execution.
  await page.locator('#language').click();
  const help = page.getByRole('button', { name: 'Shortcuts', exact: true });
  const settingsEn = page.getByRole('button', { name: 'Settings', exact: true });
  const canvas = page.locator('#viewport > canvas');
  await settingsEn.click();
  await page.getByLabel('Block Count', { exact: true }).fill('5');
  const beforePanel = await canvas.boundingBox();
  await help.click();
  const dialog = page.getByRole('dialog', { name: 'Shortcuts', exact: true });
  await dialog.waitFor();
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert(await page.evaluate(() => (window as any).stacklingUI.mode === 'idle'));
  assert.deepEqual(await canvas.boundingBox(), beforePanel);
  await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
  await page.keyboard.down('w');
  await page.waitForTimeout(180);
  await page.keyboard.up('w');
  assert.equal(await mode(), 'idle');
  await canvas.click({ position: { x: 30, y: 170 } });
  await page.keyboard.down('w');
  await page.waitForTimeout(180);
  await page.keyboard.up('w');
  assert.equal(await mode(), 'running');
  assert(await dialog.isVisible());
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await waitMode('idle');
  await teacher.click();
  await page.waitForFunction(() => (window as any).stacklingUI.episode.sim.time > 0.3);
  await help.click();
  const running = await time();
  await page.waitForTimeout(200);
  assert((await time()) > running);
  assert.deepEqual(errors, []);
  console.log('UI: panel exclusion, keyboard isolation and uninterrupted execution passed');
} finally {
  await host.close();
}
