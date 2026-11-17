import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
import { reportPath } from '../runtime/report-path';

const host = new BrowserHost();
const results: unknown[] = [];
try {
  await host.start();
  const page = await host.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('stackling.language', 'zh'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(host.url);
  await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
  for (const language of ['zh', 'en']) {
    await page
      .getByRole('button', { name: language === 'zh' ? '设置' : 'Settings', exact: true })
      .click();
    await page.locator('#block-size').click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), [
      '3.5 cm',
      '5 cm',
      '7.5 cm',
    ]);
    await page.getByRole('option', { name: '3.5 cm', exact: true }).click();
    assert.equal(await page.locator('#block-size').innerText(), '3.5 cm');
    await page.waitForFunction(
      () => (window as any).stacklingUI.episode.sim.objects[0].shape.size[0] === 0.035,
    );
    await page.screenshot({ path: await reportPath(`block-size-${language}.png`) });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
    assert.equal(
      await page.evaluate(() => (window as any).stacklingUI.config.scene.objects[0].shape.size[0]),
      0.05,
    );
    if (language === 'zh') await page.locator('#language').click();
  }

  for (const rate of [1, 5]) {
    await page.evaluate((rate) => {
      const w = window as any,
        r = w.stacklingUI;
      r.setTeacherRate(rate);
      const metrics = (w.responsiveness = { gaps: [] as number[], tasks: [] as number[] });
      const awaitingFirstPlan = () =>
        r.mode === 'running' && r.episode.source.teacher?.decisions.length === 0;
      const observer = new PerformanceObserver((list) => {
        if (awaitingFirstPlan())
          metrics.tasks.push(...list.getEntries().map((entry) => entry.duration));
      });
      observer.observe({ type: 'longtask' });
      let previous = performance.now(),
        wasStarting = false,
        frame: number;
      const sample = (now: number) => {
        if (wasStarting) metrics.gaps.push(now - previous);
        previous = now;
        wasStarting = awaitingFirstPlan();
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      w.stopMeasuring = () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      };
    }, rate);
    await page.locator('#teacher').click();
    await page.waitForFunction(() => (window as any).stacklingUI.mode === 'running');
    // Pending-planning cancellation is covered deterministically in planning-scheduling.test.ts.
    // Browser controls must work whether planning is still pending or has already completed.
    await page.locator('#play').click();
    assert.equal(await page.evaluate(() => (window as any).stacklingUI.mode), 'paused');
    await page.evaluate(() => (window as any).stacklingUI.episode.settled());
    const paused = await page.evaluate(() => (window as any).stacklingUI.episode.sim.inspect());
    const decisions = await page.evaluate(
      () => (window as any).stacklingUI.episode.source.teacher.decisions.length,
    );
    await page.waitForTimeout(150);
    assert.deepEqual(
      await page.evaluate(() => (window as any).stacklingUI.episode.sim.inspect()),
      paused,
    );
    assert.equal(
      await page.evaluate(
        () => (window as any).stacklingUI.episode.source.teacher.decisions.length,
      ),
      decisions,
    );
    await page.locator('#play').click();
    await page.waitForFunction(
      () => (window as any).stacklingUI.episode.source.teacher.decisions.length > 0,
      undefined,
      { timeout: 60_000 },
    );
    const metrics = await page.evaluate(() => {
      const w = window as any,
        { gaps, tasks } = w.responsiveness;
      w.stopMeasuring();
      gaps.sort((a: number, b: number) => a - b);
      return {
        startupFrames: gaps.length,
        medianGapMs: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
        maxGapMs: Math.max(0, ...gaps),
        maxLongTaskMs: Math.max(0, ...tasks),
      };
    });
    results.push({ rate, ...metrics });
    console.log(JSON.stringify({ rate, ...metrics }));
    assert(metrics.maxGapMs < 250, `Startup blocked painting for ${metrics.maxGapMs} ms`);
    assert(metrics.maxLongTaskMs < 250, `Startup blocked input for ${metrics.maxLongTaskMs} ms`);
    await page.screenshot({ path: await reportPath(`teacher-responsive-${rate}x.png`) });
    if (rate === 5) {
      await page.waitForFunction(() => (window as any).stacklingUI.episode.result, undefined, {
        timeout: 60_000,
      });
      const result = await page.evaluate(() => (window as any).stacklingUI.episode.result);
      assert.equal(result.outcome, 'success');
      results.push({ completedAtRate: rate, ticks: result.ticks, outcome: result.outcome });
    }
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  }
  // Reset must stop an active episode before its physics world is replaced.
  await page.locator('#teacher').click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'running');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForFunction(() => (window as any).stacklingUI.mode === 'idle');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => (window as any).stacklingUI.episode.sim.ticks), 0);
  assert.deepEqual(errors, []);
  await writeFile(
    await reportPath('ui-responsiveness.json'),
    JSON.stringify({ browser: host.browserVersion, results }, null, 2) + '\n',
  );
  console.log('Block size labels, planning responsiveness, pause/resume and reset passed');
} finally {
  await host.close();
}
