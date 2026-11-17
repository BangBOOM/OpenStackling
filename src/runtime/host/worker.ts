import type { HostData } from '../host-wire';
import type { PacketRow } from '../recording/protocol';
import { parentPort } from 'node:worker_threads';
import { session } from './session';

const port = parentPort!;
let sequence = 0;
const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
const runtime = session(
  (data) => {
    if (typeof data === 'string') port.postMessage({ data });
    else port.postMessage({ data }, [data.buffer as ArrayBuffer]);
  },
  (recording, rows: PacketRow[]) =>
    new Promise<void>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      port.postMessage({ record: { id, recording, rows } });
    }),
);
port.on(
  'message',
  (message: { data?: HostData; close?: boolean; recorded?: number; recordError?: string }) => {
    if (message.recorded !== undefined) {
      const call = pending.get(message.recorded)!;
      pending.delete(message.recorded);
      if (message.recordError) call.reject(new Error(message.recordError));
      else call.resolve();
    } else if (message.close) {
      void runtime.close().finally(() => port.postMessage({ closed: true }));
    } else {
      void runtime
        .receive(message.data!)
        .catch((error) => port.postMessage({ error: String(error) }));
    }
  },
);
