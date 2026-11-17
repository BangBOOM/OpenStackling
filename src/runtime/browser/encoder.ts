import type { PendingFrame } from './render/camera';
export type EncodedFrame = { png?: Uint8Array; gzDepth?: Uint8Array };
type Reply = { id: number; error?: string; encodeMs?: number; mp4?: Uint8Array };
export class FrameEncoder {
  private worker = new Worker(new URL('./encode-worker.ts', import.meta.url), { type: 'module' });
  private next = 0;
  private disposed = false;
  private jobs = new Map<number, { resolve: (reply: Reply) => void; reject: (e: Error) => void }>();
  encodeMs = 0;
  constructor() {
    this.worker.onmessage = (e: MessageEvent<Reply>) => {
      const d = e.data,
        job = this.jobs.get(d.id);
      // A reply may arrive after dispose() cleared pending jobs (page teardown race).
      if (!job) return;
      this.jobs.delete(d.id);
      if (d.encodeMs !== undefined) this.encodeMs += d.encodeMs;
      if (d.error) job.reject(new Error(d.error));
      else job.resolve(d);
    };
    this.worker.onerror = (e) => {
      for (const j of this.jobs.values()) j.reject(new Error(e.message));
      this.jobs.clear();
    };
  }
  private call<T extends Reply>(message: Record<string, unknown>, transfer: Transferable[] = []) {
    if (this.disposed) return Promise.reject<T>(new Error('Encoder closed'));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.jobs.set(id, { resolve: resolve as (reply: Reply) => void, reject });
      this.worker.postMessage({ id, ...message }, transfer);
    });
  }
  startEpisode(options: {
    width: number;
    height: number;
    gop: number;
    framerate: number;
    bitrate: number;
  }) {
    return this.call<{ id: number; codec: string }>({
      kind: 'episode',
      op: 'start',
      ...options,
    }).then((d) => d.codec);
  }
  encode(
    tick: number,
    frame: PendingFrame,
    width: number,
    height: number,
    wantPng: boolean,
    physicsHz: number,
    observationHz: number,
    gop: number,
  ) {
    const transfer: Transferable[] = [frame.rgba.buffer as ArrayBuffer];
    if (frame.depthRgba) transfer.push(frame.depthRgba.buffer as ArrayBuffer);
    return this.call<EncodedFrame & Reply>(
      {
        kind: 'frame',
        tick,
        width,
        height,
        gop,
        rgba: frame.rgba,
        depthRgba: frame.depthRgba,
        wantPng,
        physicsHz,
        observationHz,
      },
      transfer,
    );
  }
  finish() {
    return this.call<{ id: number; mp4: Uint8Array }>({ kind: 'episode', op: 'end' }).then(
      (d) => d.mp4,
    );
  }
  abort() {
    void this.call({ kind: 'episode', op: 'abort' }).catch(() => {});
  }
  dispose() {
    this.disposed = true;
    for (const j of this.jobs.values()) j.reject(new Error('Encoder closed'));
    this.jobs.clear();
    this.worker.terminate();
  }
}
