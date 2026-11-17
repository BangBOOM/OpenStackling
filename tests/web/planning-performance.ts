import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { BrowserHost } from '../../src/runtime/runs/browser-host';
import { provenance } from '../../src/runtime/provenance';
import { reportPath } from '../runtime/report-path';
const source = await provenance();
const report = await reportPath('planning-performance.json', process.env.REPORT);
const host = new BrowserHost();
const rows: Record<string, unknown>[] = [];
try {
  await host.start();
  for (let trial = 0; trial < 5; trial++) {
    const page = await host.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const trialResult: Record<string, unknown> = { trial, errors, status: 'running' };
    rows.push(trialResult);
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(host.url);
      await page.waitForFunction(() => (window as any).stacklingUI?.mode === 'idle');
      await page.evaluate(async () => {
        const path = '/src/simulation/control/teachers/whole-body.ts';
        const { WholeBodyTeacher } = await import(path);
        const w = window as any;
        w.measure = { start: 0, end: 0, cpuMs: 0, slices: 0, gaps: [], calls: {}, click: 0 };
        for (const name of ['nextBlock', 'transport']) {
          const original = WholeBodyTeacher.prototype[name];
          WholeBodyTeacher.prototype[name] = function* (...args: any[]) {
            const m = w.measure;
            m.calls[name] = (m.calls[name] ?? 0) + 1;
            if (name !== 'nextBlock' || m.start) return yield* original.apply(this, args);
            m.start = performance.now();
            const work = original.apply(this, args);
            let step;
            do {
              const start = performance.now();
              step = work.next();
              m.cpuMs += performance.now() - start;
              m.slices++;
              if (!step.done) yield;
            } while (!step.done);
            m.end = performance.now();
            return step.value;
          };
        }
        document.querySelector('#teacher')!.addEventListener(
          'click',
          () => {
            w.measure.click = performance.now();
          },
          true,
        );
        let previous = performance.now();
        const tick = (now: number) => {
          if (w.measure.start && !w.measure.end) w.measure.gaps.push(now - previous);
          previous = now;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await page.locator('#teacher').click();
      await page.waitForFunction(() => (window as any).measure.end > 0, undefined, {
        timeout: 90000,
      });
      const row = await page.evaluate(() => {
        const w = window as any,
          m = w.measure,
          r = w.stacklingUI;
        return {
          config: r.config,
          planningMs: m.end - m.start,
          clickToPlanMs: m.end - m.click,
          cpuMs: m.cpuMs,
          slices: m.slices,
          calls: m.calls,
          maxFrameGapMs: Math.max(0, ...m.gaps),
          decisions: r.episode.source.teacher.decisions,
          rejected: r.episode.source.teacher.rejected,
        };
      });
      Object.assign(trialResult, row);
      assert(row.maxFrameGapMs < 250);
      assert.deepEqual(errors, []);
      let completion;
      if (trial === 4) {
        await page.waitForFunction(
          () => Boolean((window as any).stacklingUI.episode.result),
          undefined,
          { timeout: 90_000 },
        );
        completion = await page.evaluate(() => (window as any).stacklingUI.episode.result);
        trialResult.completion = completion;
        assert.equal(completion.outcome, 'success');
        await page.screenshot({ path: report + '.png' });
      }
      assert.deepEqual(errors, []);
      trialResult.status = 'passed';
      console.log(
        JSON.stringify({
          trial,
          planningMs: row.planningMs,
          clickToPlanMs: row.clickToPlanMs,
          cpuMs: row.cpuMs,
          slices: row.slices,
          calls: row.calls,
          maxFrameGapMs: row.maxFrameGapMs,
        }),
      );
    } catch (error) {
      trialResult.status = 'failed';
      trialResult.failure = String(error);
      throw error;
    } finally {
      await writeFile(
        report,
        JSON.stringify({ source, browser: host.browserVersion, trials: 5, rows }, null, 2),
      );
      await page.close();
    }
  }
} finally {
  await host.close();
}
