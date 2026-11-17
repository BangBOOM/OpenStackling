import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
import { reportPath } from '../runtime/report-path';

const host = new BrowserHost();
const samples = [];
try {
  await host.start();
  const page = await host.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('stackling.language', 'zh'));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(host.url);
  await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
  const rate = page.getByRole('combobox', { name: '自动堆叠倍速' });
  for (const speed of [1, 2, 5]) {
    await rate.click();
    await page.getByRole('option', { name: `${speed}×`, exact: true }).click();
    await page.locator('#teacher').click();
    await page.waitForFunction(
      () => (window as any).stacklingUI.episode.source.teacher?.decisions.length > 0,
    );
    // Measure physical execution after initial planning, before the next placement plan.
    // Real RAF scheduling must keep up without the extra drain frames in ui.ts.
    await page.locator('#play').click();
    await page.evaluate(async () => {
      const r = (window as any).stacklingUI;
      await r.episode.settled();
      await r.stepping;
    });
    await page.locator('#play').click();
    const sample = await page.evaluate(async (speed) => {
      const r = (window as any).stacklingUI;
      const start = performance.now(),
        ticks = r.episode.sim.ticks;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return {
        speed,
        wallSeconds: (performance.now() - start) / 1000,
        simulationSeconds: (r.episode.sim.ticks - ticks) * r.episode.sim.dt,
        dt: r.episode.sim.dt,
      };
    }, speed);
    samples.push(sample);
    console.log(JSON.stringify(sample));
    const actualRate = sample.simulationSeconds / sample.wallSeconds;
    assert(actualRate > speed * 0.85, `${speed}× only advanced at ${actualRate.toFixed(2)}×`);
    assert(
      actualRate < speed * 1.15,
      `${speed}× advanced too quickly at ${actualRate.toFixed(2)}×`,
    );
    assert.equal(sample.dt, 1 / 120);
    await page.screenshot({ path: await reportPath(`ui-pacing-${speed}x.png`) });
    await page.locator('#play').click();
    await page.evaluate(() => (window as any).stacklingUI.episode.settled());
    const paused = await page.evaluate(() => (window as any).stacklingUI.episode.sim.inspect());
    await page.waitForTimeout(100);
    assert.deepEqual(
      await page.evaluate(() => (window as any).stacklingUI.episode.sim.inspect()),
      paused,
    );
    await page.locator('#play').click();
    if (speed === 5) {
      await page.waitForFunction(() => (window as any).stacklingUI.episode.result, undefined, {
        timeout: 60_000,
      });
      assert.equal(
        await page.evaluate(() => (window as any).stacklingUI.episode.result.outcome),
        'success',
      );
    }
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  }
  assert.deepEqual(errors, []);
  console.log('Real RAF pacing at 1×/2×/5×, pause/resume and 5× completion passed');
} finally {
  await writeFile(
    await reportPath('ui-pacing.json'),
    JSON.stringify({ browser: host.browserVersion, samples }, null, 2) + '\n',
  );
  await host.close();
}
