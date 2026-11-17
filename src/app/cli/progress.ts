// Whole-line progress reporting for dataset collection. On a TTY a single
// in-place status line is repainted on stderr; elsewhere status lines are
// throttled by time and episode count so redirected logs stay bounded. Every
// write is one complete line, so concurrent workers cannot interleave output.
const STATUS_INTERVAL_MS = 30_000,
  STATUS_EPISODES = 100,
  PAINT_INTERVAL_MS = 100;

export function collectProgress(
  total: number,
  completed: number,
  successes: number,
  label = 'collect',
) {
  const tty = process.stderr.isTTY === true,
    start = performance.now(),
    startCompleted = completed;
  let active = 0,
    lastPaint = 0,
    lastStatus = start,
    lastStatusCompleted = completed;
  const duration = (seconds: number) => {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 3600)}:${String(Math.floor((whole % 3600) / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
  };
  const status = () => {
    const elapsed = (performance.now() - start) / 1000,
      rate = elapsed > 0 ? (completed - startCompleted) / elapsed : 0,
      remaining = total - completed,
      eta = rate > 0 && remaining > 0 ? remaining / rate : undefined;
    return (
      `${label} ${completed}/${total} episodes, ${successes} success, ` +
      `${completed - successes} failed, ` +
      `${rate >= 1 ? `${rate.toFixed(1)} ep/s` : `${Math.round(rate * 3600)} ep/h`}, ` +
      `elapsed ${duration(elapsed)}, eta ${eta === undefined ? '--:--:--' : duration(eta)}, ` +
      `workers ${active}`
    );
  };
  const paint = (force = false) => {
    if (!tty || (!force && performance.now() - lastPaint < PAINT_INTERVAL_MS)) return;
    lastPaint = performance.now();
    // \r returns to column 0; \x1b[K erases leftovers from a longer prior line.
    process.stderr.write(`\r${status()}\x1b[K`);
  };
  const line = (message: string) => process.stderr.write(`${message}\n`);
  const timer = tty ? setInterval(() => paint(), 1000) : undefined;
  timer?.unref();
  if (tty) paint(true);
  return {
    worker(delta: number) {
      active += delta;
      paint();
    },
    episode(success: boolean) {
      completed++;
      if (success) successes++;
      if (tty) paint();
      else if (
        completed - lastStatusCompleted >= STATUS_EPISODES ||
        (performance.now() - lastStatus >= STATUS_INTERVAL_MS && completed > lastStatusCompleted)
      ) {
        lastStatus = performance.now();
        lastStatusCompleted = completed;
        line(status());
      }
    },
    // Exception events keep their own line; the progress line is cleared and
    // redrawn around them so a TTY never shows both on one row.
    event(message: string) {
      if (tty) {
        process.stderr.write('\r\x1b[K');
        line(message);
        paint(true);
      } else line(message);
    },
    stop() {
      clearInterval(timer);
      if (tty) {
        paint(true);
        process.stderr.write('\n');
      } else line(status());
    },
  };
}
