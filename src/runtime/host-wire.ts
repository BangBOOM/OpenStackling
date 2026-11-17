import type { RpcMessage } from './host-protocol';
import type { MeasuredFrame } from '../simulation/world/frame';
import { measuredFrameValues, readMeasuredFrame } from '../simulation/world/frame-buffer';

export type HostData = string | Uint8Array;
type Location = 'world' | 'episode' | 'opened' | 'callback';
const encoder = new TextEncoder(),
  decoder = new TextDecoder();

export function encodeHostMessage(message: RpcMessage): HostData {
  const m = message as any;
  let physics: MeasuredFrame | undefined;
  let location: Location | undefined;
  let envelope = m;
  if (m.payload?.frame?.physics) {
    location = 'callback';
    physics = m.payload.frame.physics;
    envelope = { ...m, payload: { ...m.payload, frame: { ...m.payload.frame, physics: null } } };
  } else if (m.value?.frame?.physics) {
    location = 'opened';
    physics = m.value.frame.physics;
    envelope = { ...m, value: { ...m.value, frame: { ...m.value.frame, physics: null } } };
  } else if (m.value?.physics) {
    location = 'episode';
    physics = m.value.physics;
    envelope = { ...m, value: { ...m.value, physics: null } };
  } else if (m.value?.bodies && m.value?.state) {
    location = 'world';
    physics = m.value;
    envelope = { ...m, value: null };
  }
  if (!physics) return JSON.stringify(message);
  const header = encoder.encode(JSON.stringify({ message: envelope, location }));
  const start = Math.ceil((4 + header.length) / 8) * 8;
  const values = measuredFrameValues(physics);
  const packet = new Uint8Array(start + values.byteLength);
  new DataView(packet.buffer).setUint32(0, header.length, true);
  packet.set(header, 4);
  packet.set(new Uint8Array(values.buffer), start);
  return packet;
}

export function decodeHostMessage(data: HostData | ArrayBuffer): RpcMessage {
  if (typeof data === 'string') return JSON.parse(data);
  const packet = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (packet.byteLength < 8) throw new Error('Truncated host packet');
  const size = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, true);
  const start = Math.ceil((4 + size) / 8) * 8;
  if (start > packet.length || (packet.length - start) % 8 !== 0)
    throw new Error('Invalid host frame size');
  const { message, location } = JSON.parse(decoder.decode(packet.subarray(4, 4 + size)));
  // Node Buffers may have an unaligned byteOffset. Copy that view before decoding.
  const bytes = packet.subarray(start);
  const values =
    bytes.byteOffset % 8 === 0
      ? new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8)
      : new Float64Array(Uint8Array.from(bytes).buffer);
  const frame = readMeasuredFrame(values);
  switch (location as Location) {
    case 'world':
      message.value = frame;
      break;
    case 'episode':
      message.value.physics = frame;
      break;
    case 'opened':
      message.value.frame.physics = frame;
      break;
    case 'callback':
      message.payload.frame.physics = frame;
      break;
    default:
      throw new Error('Invalid host frame location');
  }
  return message;
}
