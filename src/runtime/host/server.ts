import type { PacketRow, PacketSink } from '../recording/protocol';
import type { HostData } from '../host-wire';
import { WebSocketServer } from 'ws';
import { Worker } from 'node:worker_threads';

type Server = NonNullable<import('vite').ViteDevServer['httpServer']>;
const recordings = new WeakMap<Server, Map<string, PacketSink>>();

export function registerRecording(server: Server, id: string, sink: PacketSink) {
  let entries = recordings.get(server);
  if (!entries) {
    entries = new Map();
    recordings.set(server, entries);
  }
  let pending = Promise.resolve();
  const queued: PacketSink = {
    append(rows) {
      pending = pending.then(() => sink.append(rows));
      return pending;
    },
  };
  entries.set(id, queued);
  return { sink: queued, close: () => entries!.delete(id) };
}

export function attach(server: NonNullable<import('vite').ViteDevServer['httpServer']>) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  const onUpgrade = (
    request: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ) => {
    if (request.url !== '/api/runtime') return;
    if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws));
  };
  server.on('upgrade', onUpgrade);
  sockets.on('connection', (socket) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url));
    worker.on(
      'message',
      (message: {
        data?: HostData;
        closed?: boolean;
        error?: string;
        record?: { id: number; recording: string; rows: PacketRow[] };
      }) => {
        if (message.record) {
          const { id, recording, rows } = message.record;
          const sink = recordings.get(server)?.get(recording);
          const result = sink
            ? sink.append(rows)
            : Promise.reject(new Error('Unknown host recording'));
          void result.then(
            () => worker.postMessage({ recorded: id }),
            (error) => worker.postMessage({ recorded: id, recordError: String(error) }),
          );
          return;
        }
        if (message.closed) void worker.terminate();
        else if (message.error) socket.close(1011, message.error.slice(0, 100));
        else if (socket.readyState === socket.OPEN) socket.send(message.data!);
      },
    );
    worker.on('error', () => socket.close(1011, 'Episode worker failed'));
    socket.on('message', (data) => worker.postMessage({ data: data.toString() }));
    socket.on('close', () => worker.postMessage({ close: true }));
  });
  server.on('close', () => {
    server.off('upgrade', onUpgrade);
    for (const client of sockets.clients) client.close();
    sockets.close();
  });
}
