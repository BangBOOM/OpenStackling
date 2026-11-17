import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
import { TASK_PRESETS } from '../../src/runtime/presets';
import en from '../../src/app/web/locales/en.json' with { type: 'json' };
import zh from '../../src/app/web/locales/zh.json' with { type: 'json' };
import { reportPath } from '../runtime/report-path';

const host = new BrowserHost();
const coverage: unknown[] = [];
try {
  await host.start();
  for (const language of ['en', 'zh'] as const) {
    const strings = language === 'en' ? en : zh;
    const page = await host.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      (value) => localStorage.setItem('stackling.language', value),
      language,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(host.url);
    await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
    for (const preset of TASK_PRESETS) {
      await page.locator('#task-preset').click();
      assert.equal(await page.getByRole('option').count(), 6);
      await page.getByRole('option', { name: strings.task[preset], exact: true }).click();
      await page.waitForFunction(
        (label) => document.querySelector('[data-current-task]')?.textContent === label,
        strings.task[preset],
      );
      const selected = await page.evaluate(async () => {
        const r = (window as any).stacklingUI;
        const { taskPreset } = await import('/src/runtime/presets.ts' as string);
        return {
          preset: taskPreset(r.config),
          config: r.config,
          axes: r.episode.sim.state().length,
          mode: r.mode,
        };
      });
      assert.equal(selected.preset, preset);
      assert.equal(selected.axes, 16);
      assert.equal(selected.config.environment.version, 'stackling-v5.4');
      assert(selected.config.environment.robot.body);
      assert.equal(selected.mode, 'idle');
      await page.getByRole('button', { name: strings.ui.settings, exact: true }).click();
      assert.equal(await page.locator('#task-preset').isDisabled(), true);
      assert.equal(
        await page.evaluate(() => (window as any).stacklingUI.selectTask('stack-all')),
        false,
      );
      await page.getByRole('button', { name: strings.ui.defaults, exact: true }).click();
      const preview = await page.evaluate(async () => {
        const r = (window as any).stacklingUI;
        const { useUI } = await import('/src/app/web/store.ts' as string);
        const { taskPreset } = await import('/src/runtime/presets.ts' as string);
        const draft = useUI.getState().draft;
        return {
          preset: taskPreset(draft),
          body: draft.environment.robot.body,
          axes: r.episode.sim.state().length,
        };
      });
      assert.equal(preview.preset, preset);
      assert(preview.body);
      assert.equal(preview.axes, 16);
      await page.keyboard.press('Escape');
      assert.deepEqual(
        await page.evaluate(() => (window as any).stacklingUI.config),
        selected.config,
      );
      await page.getByRole('button', { name: strings.ui.settings, exact: true }).click();
      await page.getByRole('button', { name: strings.ui.defaults, exact: true }).click();
      await page.getByRole('button', { name: strings.ui.apply, exact: true }).click();
      await page
        .getByRole('dialog', { name: strings.ui.settings, exact: true })
        .waitFor({ state: 'hidden' });
      const applied = await page.evaluate(async () => {
        const r = (window as any).stacklingUI;
        const { taskPreset } = await import('/src/runtime/presets.ts' as string);
        return {
          preset: taskPreset(r.config),
          axes: r.episode.sim.state().length,
          body: r.config.environment.robot.body,
          language: r.config.task.language,
        };
      });
      assert.equal(applied.preset, preset);
      assert.equal(applied.axes, 16);
      assert(applied.body);
      assert.equal(applied.language, language);
      coverage.push({ language, preset, selected: selected.config.task, axes: applied.axes });
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: await reportPath(`teacher-tasks-${language}.png`) });
    await page.close();
  }
  await writeFile(
    await reportPath('teacher-tasks-browser.json'),
    JSON.stringify({ coverage }, null, 2) + '\n',
  );
  console.log(
    'All six whole-body task presets, defaults, draft cancellation, permissions and both locales passed',
  );
} finally {
  await host.close();
}
