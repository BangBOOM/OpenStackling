import { registerRecording } from '../host/server';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveEpisode, type ResolvedEpisode } from '../plan';
import type { Config } from '../config';
import type { ActionRow, EpisodeResult } from '../episode-types';
import { unpack, type PacketSink } from '../recording/protocol';

const nvidiaDeviceCount = () =>
  process.platform === 'linux'
    ? readdirSync('/dev').filter((name) => /^nvidia\d+$/.test(name)).length
    : 0;

const STOP_TIMEOUT_MS = 10_000;

// Device masking needs root or unprivileged user namespaces.
const isolationAvailable = () => {
  try {
    execFileSync('unshare', ['-m', '--propagation', 'private', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export class BrowserHost {
  private server!: ViteDevServer;
  private cacheDirectory?: string;
  private browsers: Browser[] = [];
  private writers = new Map<string, PacketSink>();
  private visible = false;
  private pages = new Set<Page>();
  url = '';
  browserVersion = '';
  async start(visible = false, port = 0, browsers = 1) {
    this.visible = visible;
    const upload = (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const id = (req.url ?? '').replace(/^\//, ''),
          writer = this.writers.get(id);
        if (req.method !== 'POST' || !writer) {
          res.statusCode = 404;
          res.end('Unknown upload session');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) throw new Error('Packet exceeds 32 MiB');
          chunks.push(chunk);
        }
        await writer.append(unpack(Buffer.concat(chunks)));
        res.end('{}');
      })().catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    };
    this.cacheDirectory = await mkdtemp(path.join(tmpdir(), 'stackling-vite-'));
    this.server = await createServer({
      cacheDir: this.cacheDirectory,
      optimizeDeps: { include: ['fflate', 'ajv/dist/2020', 'json-canonicalize'] },
      configFile: 'vite.config.ts',
      logLevel: 'error',
      plugins: [
        {
          name: 'stackling-upload',
          configureServer(server) {
            server.middlewares.use('/api/chunk', upload);
            server.middlewares.use('/favicon.ico', (_req, res) => {
              res.statusCode = 204;
              res.end();
            });
          },
        },
      ],
      server: { host: '127.0.0.1', port, strictPort: port !== 0, hmr: false },
    });
    await this.server.listen();
    const address = this.server.httpServer!.address();
    if (typeof address !== 'object' || !address) throw new Error('Server did not bind');
    this.url = `http://127.0.0.1:${address.port}`;
    const installed = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      chrome = process.env.STACKLING_CHROME ?? (existsSync(installed) ? installed : undefined),
      args = [
        '--enable-gpu',
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        // Headless Linux without a display server falls back to SwiftShader;
        // the Vulkan ANGLE backend reaches the GPU without one.
        ...(process.platform === 'linux' ? ['--use-angle=vulkan'] : []),
      ];
    // Chromium has no per-device GPU switch for identical cards. Pin each
    // browser to one NVIDIA device by masking the other device nodes inside a
    // private mount namespace; extra browsers share GPUs round-robin.
    const devices = nvidiaDeviceCount(),
      pinned = devices > 1 && isolationAvailable();
    if (devices > 1 && !pinned)
      process.stderr.write(
        `[gpu] Mount namespace isolation unavailable; ${browsers} browsers will share GPU 0\n`,
      );
    this.browsers = await Promise.all(
      Array.from({ length: browsers }, (_, i) => {
        if (!pinned) return chromium.launch({ headless: !visible, executablePath: chrome, args });
        const target = i % devices,
          inner = [
            'i=0',
            `while [ $i -lt ${devices} ]; do`,
            `  [ $i -eq ${target} ] || mount --bind /dev/null /dev/nvidia$i || exit 1`,
            '  i=$((i+1))',
            'done',
            'exec "$CHROME" "$@"',
          ].join('\n');
        return (async () => {
          const wrapper = path.join(this.cacheDirectory!, `gpu-${target}.sh`);
          await writeFile(
            wrapper,
            `#!/bin/sh\nexec unshare -m --propagation private /bin/sh -c '\n${inner}\n' wrapper "$@"\n`,
          );
          await chmod(wrapper, 0o755);
          return chromium.launch({
            headless: !visible,
            executablePath: wrapper,
            args,
            env: { ...process.env, CHROME: chrome ?? chromium.executablePath() },
          });
        })();
      }),
    );
    this.browserVersion = this.browsers[0].version();
    return this;
  }
  async newPage(index = 0) {
    const page = await this.browsers[index % this.browsers.length].newPage();
    this.pages.add(page);
    await page.addInitScript('globalThis.__name = (value) => value');
    page.on('console', (m) => {
      if (m.type() === 'error') process.stderr.write(`[browser] ${m.text()}\n`);
    });
    await page.goto(this.url + '/worker.html' + (this.visible ? '?visual=1' : ''));
    await page.waitForFunction(() => Boolean((window as any).stackling));
    return page;
  }
  async run(
    page: Page,
    config: Config,
    writer?: PacketSink,
    replay?: ActionRow[],
    resolved: ResolvedEpisode = resolveEpisode(config),
  ) {
    const id = randomUUID();
    const registration = writer
      ? registerRecording(this.server.httpServer!, id, writer)
      : undefined;
    if (registration) this.writers.set(id, registration.sink);
    try {
      return (await page.evaluate(
        async ({ config, url, replay, resolved, recording }) =>
          (window as any).stackling.run(config, url, replay, resolved, recording),
        {
          config,
          url: writer ? `/api/chunk/${id}` : undefined,
          replay,
          resolved,
          recording: writer ? id : undefined,
        },
      )) as { result: EpisodeResult; metrics: Record<string, number> };
    } finally {
      registration?.close();
      this.writers.delete(id);
    }
  }
  // Graceful stop asks every page to end its episode. A page whose event loop
  // is stuck (for example awaiting an upload that never completes) never
  // replies, so after a bounded wait the browsers are closed, which rejects
  // every pending evaluate and unwedges the collector.
  async stop() {
    const graceful = Promise.allSettled(
      [...this.pages].map((p) => p.evaluate(() => (window as any).stackling.stop())),
    );
    const timedOut = await Promise.race([
      graceful.then(() => false),
      new Promise((r) => setTimeout(() => r(true), STOP_TIMEOUT_MS)),
    ]);
    if (timedOut) await Promise.allSettled(this.browsers.map((b) => b.close()));
  }
  async closePage(page: Page) {
    this.pages.delete(page);
    await page.close();
  }
  async close() {
    await this.server?.waitForRequestsIdle();
    await Promise.allSettled(this.browsers.map((b) => b.close()));
    await this.server?.close();
    if (this.cacheDirectory) await rm(this.cacheDirectory, { recursive: true, force: true });
  }
}
