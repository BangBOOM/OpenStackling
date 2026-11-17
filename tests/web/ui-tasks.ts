import assert from 'node:assert/strict';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
import { reportPath } from '../runtime/report-path';
const host = new BrowserHost();
try {
  await host.start();
  const page = await host.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('stackling.language', 'en'));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(host.url);
  await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  const options = [
    ['Stack all cubes', 'tower', 2],
    ['Partition by count', 'partition-count', 8],
    ['Partition by color', 'partition-color', 8],
    ['Stack different sizes', 'tower', 3],
    ['Stack in size order', 'tower', 3],
    ['Maximum stable height', 'max-height', 6],
  ] as const;
  for (const [label, kind, count] of options) {
    const before = await page.evaluate(() => (window as any).stacklingUI.config);
    await page.locator('#task-preset').click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await page.waitForFunction(
      ({ kind, count }) => {
        const r = (window as any).stacklingUI;
        return (
          r.mode === 'idle' && r.config.task.kind === kind && r.episode.sim.objects.length === count
        );
      },
      { kind, count },
    );
    await page.waitForFunction(
      (label) => document.querySelector('[data-current-task]')!.textContent === label,
      label,
    );
    assert.equal(
      await page.getByRole('dialog', { name: 'Settings', exact: true }).isVisible(),
      false,
    );
    const applied = await page.evaluate(() => (window as any).stacklingUI.config);
    assert.deepEqual(applied.appearance, before.appearance);
    assert.deepEqual(applied.camera, before.camera);
    await settings.click();
    assert.equal(await page.locator('#task-preset').isDisabled(), true);
    assert.equal(
      await page.evaluate(() => (window as any).stacklingUI.selectTask('stack-all')),
      false,
    );
    assert.equal(await page.locator('[data-settings] #task-preset').count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).stacklingUI.config), applied);
    await page.getByRole('button', { name: 'Restore Defaults', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).stacklingUI.config.task.kind), kind);
    assert.equal(
      await page.evaluate(async () => {
        const { useUI } = await import('/src/app/web/store.ts' as string);
        return useUI.getState().draft!.task.kind;
      }),
      kind,
    );
    assert((await page.locator('[data-task-prompt]').textContent())!.length > 60);
    assert.equal(await page.evaluate(() => (window as any).stacklingUI.episode.sim.ticks), 0);
    assert.equal(await page.evaluate(() => (window as any).stacklingUI.toggle()), false);
    assert.equal(await page.locator('#prompt-language').count(), 0);
    if (label === 'Stack different sizes' || label === 'Stack in size order') {
      await page.getByLabel('Block Count', { exact: true }).fill('5');
      await page.waitForFunction(
        () => (window as any).stacklingUI.episode.sim.objects.length === 5,
      );
      assert.equal(await page.getByLabel('Cube sizes · m', { exact: true }).count(), 0);
      await page.getByLabel('Block Count', { exact: true }).fill('3');
    }
    if (kind === 'max-height') {
      await page.getByLabel('Object count', { exact: true }).fill('8');
      await page.waitForFunction(
        () => (window as any).stacklingUI.episode.sim.objects.length === 8,
      );
      await page.getByLabel('Scene Seed', { exact: true }).fill('2026');
      await page.waitForFunction(
        () => (window as any).stacklingUI.episode.config.run.seed === 2026,
      );
      const inventory = await page.evaluate(
        () => (window as any).stacklingUI.episode.config.scene.objects,
      );
      await page.getByLabel('Scene Seed', { exact: true }).fill('42');
      await page.waitForFunction(() => (window as any).stacklingUI.episode.config.run.seed === 42);
      assert.notDeepEqual(
        await page.evaluate(() => (window as any).stacklingUI.episode.config.scene.objects),
        inventory,
      );
      await page.getByLabel('Object count', { exact: true }).fill('6');
    }
    await page.getByLabel('Scene Seed', { exact: true }).fill('42');
    await page.getByRole('button', { name: 'Apply & Reset', exact: true }).click();
    await page.waitForFunction(
      ({ kind, count }) => {
        const r = (window as any).stacklingUI;
        return (
          r.mode === 'idle' &&
          r.config.task.kind === kind &&
          r.config.scene.objects.length === count
        );
      },
      { kind, count },
    );
    await page.waitForFunction(
      (label) => document.querySelector('[data-current-task]')!.textContent === label,
      label,
    );
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  const taskBounds = await page.locator('[data-current-task]').boundingBox();
  assert(taskBounds && taskBounds.width > 0 && taskBounds.x + taskBounds.width <= 1024);
  await page.locator('[data-current-task]').hover();
  await page.getByRole('tooltip', { name: 'Maximum stable height', exact: true }).waitFor();
  await page.screenshot({ path: await reportPath('toolbar-task-1024.png') });
  await page.mouse.move(700, 400);
  await page.keyboard.press('Escape');
  await page
    .getByRole('tooltip', { name: 'Maximum stable height', exact: true })
    .waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: await reportPath('toolbar-task-1440.png') });
  await settings.click();
  await page.getByLabel('Object count', { exact: true }).fill('8');
  await page.getByLabel('Scene Seed', { exact: true }).fill('2026');
  await page.getByRole('button', { name: 'Apply & Reset', exact: true }).click();
  await page.waitForFunction(() => {
    const r = (window as any).stacklingUI;
    return r.mode === 'idle' && r.config.scene.objects.length === 8;
  });
  const fixed = await page.evaluate(() => (window as any).stacklingUI.config.scene.objects);
  await page.getByRole('button', { name: 'Generate Scene', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  assert.deepEqual(
    await page.evaluate(() => (window as any).stacklingUI.config.scene.objects),
    fixed,
  );
  await settings.click();
  await page.getByLabel('Scene Seed', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Apply & Reset', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  const random = await page.evaluate(() => (window as any).stacklingUI.config);
  await page.getByRole('button', { name: 'Generate Scene', exact: true }).click();
  await page.waitForFunction((seed) => {
    const r = (window as any).stacklingUI;
    return r.mode === 'idle' && r.config.run.seed !== seed;
  }, random.run.seed);
  const regenerated = await page.evaluate(() => (window as any).stacklingUI.config);
  assert.equal(regenerated.scene.objects.length, 8);
  assert.notEqual(regenerated.run.seed, random.run.seed);
  assert.notDeepEqual(regenerated.scene.objects, random.scene.objects);
  await page.locator('#task-preset').click();
  await page.getByRole('option', { name: 'Stack in size order', exact: true }).click();
  await page.waitForFunction(
    () => (window as any).stacklingUI.config.task.order === 'size-descending',
  );
  await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    (window as any).taskOriginal = { episode: r.episode, snapshot: r.episode.sim.inspect() };
  });
  await settings.click();
  await page.locator('#task-order').click();
  await page.getByRole('option', { name: 'Small to large', exact: true }).click();
  await page.locator('#language').click();
  await page.waitForFunction(
    () => document.querySelector('[data-current-task]')!.textContent === '不同尺寸顺序堆叠',
  );
  await page.waitForFunction(() =>
    document.querySelector('[data-task-prompt]')!.textContent!.includes('由小到大'),
  );
  const prompt = await page.locator('[data-task-prompt]').textContent();
  await page.locator('#language').click();
  assert.notEqual(await page.locator('[data-task-prompt]').textContent(), prompt);
  await page.waitForFunction(() =>
    document.querySelector('[data-task-prompt]')!.textContent!.includes('smallest to largest'),
  );
  await page.locator('#language').click();
  await page.screenshot({ path: await reportPath('multitask-settings.png') });
  await page.keyboard.press('Escape');
  assert(
    await page.evaluate(() => {
      const r = (window as any).stacklingUI,
        s = (window as any).taskOriginal;
      return (
        r.episode === s.episode &&
        JSON.stringify(r.episode.sim.inspect()) === JSON.stringify(s.snapshot)
      );
    }),
  );
  await page.locator('#task-preset').click();
  await page.getByRole('option', { name: '限时自由堆高', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.config.task.kind === 'max-height');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '运行', exact: true }).click();
  await page.getByLabel('任务时限 · s', { exact: true }).fill('1');
  await page.getByRole('button', { name: '应用并重置', exact: true }).click();
  await page.locator('#play').click();
  assert.equal(await page.locator('#task-preset').isDisabled(), true);
  assert.equal(
    await page.evaluate(() => (window as any).stacklingUI.selectTask('stack-all')),
    false,
  );
  await page.locator('#play').click();
  assert.equal(await page.locator('#task-preset').isDisabled(), true);
  assert.equal(
    await page.evaluate(() => (window as any).stacklingUI.selectTask('stack-all')),
    false,
  );
  await page.locator('#play').click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'finished', undefined, {
    timeout: 15000,
  });
  const result = await page.evaluate(() => (window as any).stacklingUI.episode.result);
  assert.equal(result.outcome, 'completed');
  assert(result.evaluation.heightMeters > 0);
  assert.equal(result.task.prompt.language, 'zh');
  assert.match(await page.locator('[data-task-progress]').innerText(), /m$/);
  await page.locator('#task-preset').click();
  await page.getByRole('option', { name: '不同尺寸自由堆叠', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.config.task.kind === 'tower');
  await page.locator('#task-preset').click();
  await page.getByRole('option', { name: '限时自由堆高', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '运行', exact: true }).click();
  await page.getByLabel('任务时限 · s', { exact: true }).fill('10');
  await page.getByRole('button', { name: '应用并重置', exact: true }).click();
  await page.evaluate(() => (window as any).stacklingUI.setTeacherRate(5));
  await page.locator('#teacher').click();
  await page.waitForFunction(async () => {
    const { useUI } = await import('/src/app/web/store.ts' as string);
    return useUI.getState().telemetry.phase === 'waiting';
  });
  await page.getByText('等待截止结算', { exact: true }).waitFor();
  assert((await page.locator('[data-run-status]').innerText()).includes('等待截止结算'));
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'finished', undefined, {
    timeout: 15000,
  });
  assert.equal(
    await page.evaluate(() => (window as any).stacklingUI.episode.result.outcome),
    'completed',
  );
  assert.deepEqual(errors, []);
  console.log(
    'desktop tasks: six presets, preview/apply/cancel, bilingual prompts, permissions and height settlement passed',
  );
} finally {
  await host.close();
}
