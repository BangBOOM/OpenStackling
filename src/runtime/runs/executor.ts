import { BrowserHost } from './browser-host';

import { EpisodeHost } from '../host/episode-host';
import { type EpisodeFrame, HOST_PROTOCOL_VERSION } from '../host-protocol';

import type { Execution, WorkerExecutor, RunExecutor, RunOptions } from './contracts';
export class BrowserExecutor implements RunExecutor {
  private host: BrowserHost;
  constructor(
    private options: RunOptions,
    private recording: boolean,
  ) {
    this.host = options.policy?.host ?? new BrowserHost();
  }
  get browserVersion() {
    return this.host.browserVersion;
  }
  async start(workers: number) {
    if (!this.options.policy) await this.host.start(this.options.visible, 0, workers);
  }
  async worker(index: number): Promise<WorkerExecutor> {
    let page = this.options.policy?.page ?? (await this.host.newPage(index));
    return {
      run: (plan, sink) => this.host.run(page, plan.config, sink, undefined, plan),
      retry: async (error) => {
        const message = String(error);
        if (
          !this.recording ||
          this.options.policy ||
          (!message.includes('encoder-no-decoder-config') &&
            !message.includes("reading 'colorSpace'"))
        )
          return false;
        await this.host.closePage(page);
        page = await this.host.newPage(index);
        return true;
      },
    };
  }
  stop() {
    return this.host.stop();
  }
  close() {
    return this.host.close();
  }
}
export class NodeExecutor implements RunExecutor {
  readonly browserVersion = '';
  private hosts = new Set<EpisodeHost>();
  private active = new Set<EpisodeHost>();
  async start() {}
  async worker(): Promise<WorkerExecutor> {
    const host = new EpisodeHost();
    this.hosts.add(host);
    return {
      run: async (plan) => {
        this.active.add(host);
        let opened = false;
        try {
          await host.request('open', {
            version: HOST_PROTOCOL_VERSION,
            config: plan.config,
            plan,
            source: 'teacher',
            name: 'teacher',
            sink: [],
          });
          opened = true;
          const frame = await host.request<EpisodeFrame>('run');
          return { result: frame.result!, metrics: {} };
        } finally {
          if (opened) await host.request('dispose');
          this.active.delete(host);
        }
      },
      retry: async () => false,
    };
  }
  async stop() {
    await Promise.all(
      [...this.active].map((host) =>
        host.request('finish', { outcome: 'stopped', reason: 'user interrupted' }),
      ),
    );
  }
  async close() {
    await this.stop();
    await Promise.all([...this.hosts].map((host) => host.close()));
    this.hosts.clear();
  }
}
