import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
// Sum RSS over this coordinator and descendants. Shared pages may be counted twice.
export function memorySampler() {
  let nodePeak = process.memoryUsage().rss,
    treePeak: number | null = null,
    pending: Promise<void> | undefined;
  const sample = async () => {
    nodePeak = Math.max(nodePeak, process.memoryUsage().rss);
    if (process.platform === 'win32') return;
    try {
      const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=']);
      const rows = stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number));
      const descendants = new Set([process.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, parent] of rows)
          if (descendants.has(parent) && !descendants.has(pid)) {
            descendants.add(pid);
            changed = true;
          }
      }
      const total = rows.reduce(
        (n, [pid, , rss]) => n + (descendants.has(pid) ? rss * 1024 : 0),
        0,
      );
      treePeak = Math.max(treePeak ?? 0, total);
    } catch {
      /* RSS of the coordinator remains available if ps is unavailable. */
    }
  };
  const tick = () => {
    if (!pending)
      pending = sample().finally(() => {
        pending = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 500);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await pending;
      await sample();
      return {
        nodePeakRssBytes: nodePeak,
        processTreePeakRssBytes: treePeak,
        memorySamplingIntervalMs: 500,
      };
    },
  };
}
