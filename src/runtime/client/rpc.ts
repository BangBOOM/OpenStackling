import { decodeHostMessage } from '../host-wire';
import { rpcError, type RpcMessage } from '../host-protocol';

export class Connection {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private fault?: Error;
  handler: (method: string, payload: unknown) => unknown | Promise<unknown> = () => {
    throw new Error('Host callback handler is not installed');
  };
  private constructor(private socket: WebSocket) {
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (event) => {
      void this.receive(decodeHostMessage(event.data));
    };
    socket.onclose = () => {
      this.fault = new Error('Runtime connection closed');
      for (const call of this.pending.values()) call.reject(this.fault);
      this.pending.clear();
    };
  }
  static async connect() {
    const socket = new WebSocket(
      new URL('/api/runtime', location.href).href.replace(/^http/, 'ws'),
    );
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('Cannot connect to episode host'));
    });
    return new Connection(socket);
  }
  request<T = void>(method: string, payload: unknown = null): Promise<T> {
    if (this.fault) return Promise.reject(this.fault);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ id, method, payload }));
    });
  }
  private async receive(message: RpcMessage) {
    if (!('method' in message)) {
      const call = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error)
        call.reject(Object.assign(new Error(message.error.message), message.error));
      else call.resolve(message.value);
      return;
    }
    try {
      const value = await this.handler(message.method, message.payload);
      this.socket.send(JSON.stringify({ id: message.id, value }));
    } catch (error) {
      this.socket.send(JSON.stringify({ id: message.id, error: rpcError(error) }));
    }
  }
  close() {
    this.socket.close();
  }
}
