import { reportPath } from '../runtime/report-path';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { BrowserHost } from '../../src/runtime/runs/browser-host';

const zh = JSON.parse(await readFile('src/app/web/locales/zh.json', 'utf8'));
const en = JSON.parse(await readFile('src/app/web/locales/en.json', 'utf8'));
function compareLocales(a: Record<string, any>, b: Record<string, any>) {
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const key of Object.keys(a)) {
    if (typeof a[key] === 'string')
      assert.deepEqual(a[key].match(/{{\w+}}/g), b[key].match(/{{\w+}}/g));
    else compareLocales(a[key], b[key]);
  }
}
compareLocales(zh, en);
const host = new BrowserHost();
try {
  await host.start();
  // Browser language only chooses the first visit; an explicit selection wins on reload.
  for (const [language, expected] of [
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-CN'],
    ['en-US', 'en'],
    ['fr-FR', 'en'],
  ]) {
    const p = await host.newPage();
    await p.addInitScript((language) => {
      Object.defineProperty(navigator, 'languages', { get: () => [language] });
    }, language);
    await p.goto(host.url);
    await p.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
    assert.equal(await p.locator('html').getAttribute('lang'), expected);
    await p.close();
  }
  const page = await host.newPage(),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(host.url);
  await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.locator('#language').click();
  assert.equal(await page.getByRole('button', { name: '设置', exact: true }).count(), 1);
  await page.reload();
  await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.evaluate(() => localStorage.getItem('stackling.language')), 'zh');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('场景种子', { exact: true }).fill('2026');
  await page.waitForFunction(() => (window as any).stacklingUI.episode.config.run.seed === 2026);
  await page.getByRole('tab', { name: '相机', exact: true }).click();
  await page.getByLabel('视野角度 · °', { exact: true }).fill('180');
  await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    (window as any).savedLanguageState = {
      episode: r.episode,
      config: structuredClone(r.config),
      camera: r.camera.position.toArray(),
      compass: Array.from(document.querySelectorAll('svg[role="img"] text'), (e) => [
        e.getAttribute('x'),
        e.getAttribute('y'),
      ]),
      rgb: r.sensor.capture().rgb,
    };
  });
  await page.locator('#language').click();
  assert(await page.getByRole('dialog', { name: 'Settings', exact: true }).isVisible());
  assert.equal(await page.getByLabel('Field of View · °', { exact: true }).inputValue(), '180');
  assert(await page.getByRole('button', { name: 'Apply & Reset' }).isDisabled());
  assert.match(await page.getByRole('alert').innerText(), /Check camera/);
  assert.equal(await page.locator('[data-camera="N"]').innerText(), 'N');
  assert.equal(await page.locator('svg[role="img"] text').first().textContent(), 'N');
  assert(
    await page.evaluate(() => {
      const r = (window as any).stacklingUI,
        saved = (window as any).savedLanguageState;
      return (
        r.episode === saved.episode &&
        JSON.stringify(r.config) === JSON.stringify(saved.config) &&
        JSON.stringify(r.camera.position.toArray()) === JSON.stringify(saved.camera) &&
        JSON.stringify(
          Array.from(document.querySelectorAll('svg[role="img"] text'), (e) => [
            e.getAttribute('x'),
            e.getAttribute('y'),
          ]),
        ) === JSON.stringify(saved.compass) &&
        r.sensor.capture().rgb.every((v: number, i: number) => v === saved.rgb[i]) &&
        r.episode.sim.ticks === 0
      );
    }),
  );
  await page.getByLabel('Field of View · °', { exact: true }).fill('60');
  await page.getByRole('button', { name: 'Apply & Reset' }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.config.run.seed), 2026);
  await page.locator('#teacher').click();
  await page.waitForFunction(() => (window as any).stacklingUI.episode.sim.ticks > 24);
  await page.locator('#play').click();
  await page.evaluate(() => (window as any).stacklingUI.episode.settled());
  const before = await page.evaluate(() => {
    const r = (window as any).stacklingUI;
    (window as any).pausedEpisode = r.episode;
    return r.episode.sim.inspect();
  });
  await page.locator('#language').click();
  assert.equal(await page.locator('#play').getAttribute('aria-label'), '继续');
  assert.equal(await page.locator('#teacher').getAttribute('aria-label'), '停止堆叠');
  assert.deepEqual(
    await page.evaluate(() => (window as any).stacklingUI.episode.sim.inspect()),
    before,
  );
  assert(
    await page.evaluate(
      () => (window as any).stacklingUI.episode === (window as any).pausedEpisode,
    ),
  );
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const actualPrompt = await page.evaluate(
    () => (window as any).stacklingUI.episode.score.task.prompt.text,
  );
  assert.equal(await page.locator('[data-task-prompt]').innerText(), actualPrompt);
  await page.keyboard.press('Escape');
  await page.locator('#play').click();
  await page.locator('#language').click();
  assert.equal(await page.locator('#play').getAttribute('aria-label'), 'Pause');
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.mode), 'running');
  assert(!/[\p{Script=Han}]/u.test(await page.locator('[role=status]:visible').innerText()));
  assert(
    await page.evaluate(
      () => (window as any).stacklingUI.episode === (window as any).pausedEpisode,
    ),
  );
  await page.locator('#teacher').click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  for (const language of ['en', 'zh']) {
    if ((await page.locator('html').getAttribute('lang')) !== (language === 'zh' ? 'zh-CN' : 'en'))
      await page.locator('#language').click();
    for (const width of [1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const bounds = await page
        .locator('header button, header [role="combobox"], header [data-current-task]')
        .evaluateAll((items) => items.map((e) => e.getBoundingClientRect().toJSON()));
      assert(
        bounds.every((b) => b.x >= 0 && b.right <= width),
        `${language} toolbar overflow at ${width}`,
      );
    }
  }
  await page.locator('#language').click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const tab of ['Scene', 'Camera', 'Run']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    const overflow = await page.getByRole('dialog').evaluate((e) => e.scrollWidth > e.clientWidth);
    assert(!overflow, `${tab} settings overflow`);
  }
  await page.getByRole('tab', { name: 'Camera', exact: true }).click();
  await page.getByRole('switch', { name: 'Capture Depth' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: await reportPath('ui-language-en.png') });
  await page.getByRole('button', { name: 'Apply & Reset' }).click();
  await page.getByRole('tab', { name: 'Depth', exact: true }).click();
  await page.getByRole('button', { name: 'Expand Preview' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await page.locator('[data-sensor-preview]').boundingBox())!.width, 480);
  await page.getByRole('button', { name: 'Shrink Preview' }).click();
  await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
  assert.match(await page.getByRole('dialog').innerText(), /Forward \/ Back/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.deepEqual(errors, []);
  await writeFile(
    await reportPath('ui-language.json'),
    JSON.stringify(
      {
        passed: [
          'locale coverage and placeholders',
          'browser language and fallback',
          'persisted selection',
          'editing and invalid draft preserved',
          'running and paused episodes preserved',
          'translated directions and errors',
          'compass orientation and sensor pixels preserved',
          '1024–1920 px toolbar',
          'English settings, depth and shortcuts',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'UI language: detection, persistence, draft/execution preservation and bilingual layouts passed',
  );
} finally {
  await host.close();
}
