import { decodeHostMessage, type HostData } from '../host-wire';
import { Worker } from 'node:worker_threads';

// Each executor owns one Bun thread and its native worlds. Concurrent CLI
// workers therefore retain CPU parallelism without duplicating Runner logic.
export class EpisodeHost {
  private worker = new Worker(new URL('./worker.ts', import.meta.url));
  private sequence = 0;
  private fault?: Error;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private exited: Promise<void>;
  constructor() {
    this.exited = new Promise((resolve) =>
      this.worker.on('exit', () => {
        for (const call of this.pending.values()) call.reject(new Error('Episode worker exited'));
        this.pending.clear();
        resolve();
      }),
    );
    this.worker.on('message', (message: { data?: HostData; closed?: boolean; error?: string }) => {
      if (message.closed) {
        void this.worker.terminate();
        return;
      }
      if (message.error) {
        for (const call of this.pending.values()) call.reject(new Error(message.error));
        return;
      }
      const reply = decodeHostMessage(message.data!);
      if ('method' in reply) throw new Error('Headless teacher requested a browser callback');
      const call = this.pending.get(reply.id)!;
      this.pending.delete(reply.id);
      if (reply.error) call.reject(Object.assign(new Error(reply.error.message), reply.error));
      else call.resolve(reply.value);
    });
    this.worker.on('error', (value) => {
      const error = value instanceof Error ? value : new Error(String(value));
      this.fault = error;
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
    });
  }
  request<T = void>(method: string, payload: unknown = null): Promise<T> {
    if (this.fault) return Promise.reject(this.fault);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ data: JSON.stringify({ id, method, payload }) });
    });
  }
  async close() {
    this.worker.postMessage({ close: true });
    await this.exited;
  }
}
