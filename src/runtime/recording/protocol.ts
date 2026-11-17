import type { ObservationRow, ActionRow, DiagnosticRow } from '../episode-types';
export type PacketRow =
  | { kind: 'observation'; row: ObservationRow; depth?: Uint8Array }
  | { kind: 'action'; row: ActionRow }
  | { kind: 'diagnostic'; row: DiagnosticRow }
  | { kind: 'video'; data: Uint8Array; codec: string };
export function pack(rows: PacketRow[]): Uint8Array {
  const header = rows.map((r) =>
    r.kind === 'observation'
      ? { kind: r.kind, row: r.row, depthBytes: r.depth?.length ?? 0 }
      : r.kind === 'video'
        ? { kind: r.kind, bytes: r.data.length, codec: r.codec }
        : r,
  );
  const json = new TextEncoder().encode(JSON.stringify(header));
  const total =
    4 +
    json.length +
    rows.reduce(
      (n, r) =>
        n +
        (r.kind === 'observation'
          ? (r.depth?.length ?? 0)
          : r.kind === 'video'
            ? r.data.length
            : 0),
      0,
    );
  const packet = new Uint8Array(total);
  new DataView(packet.buffer).setUint32(0, json.length, true);
  packet.set(json, 4);
  let at = 4 + json.length;
  for (const r of rows)
    if (r.kind === 'observation') {
      if (r.depth) {
        packet.set(r.depth, at);
        at += r.depth.length;
      }
    } else if (r.kind === 'video') {
      packet.set(r.data, at);
      at += r.data.length;
    }
  return packet;
}
export function unpack(packet: Uint8Array): PacketRow[] {
  if (packet.length < 4) throw new Error('Truncated packet');
  const length = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(
    0,
    true,
  );
  if (length > packet.length - 4) throw new Error('Truncated header');
  const header = JSON.parse(new TextDecoder().decode(packet.subarray(4, 4 + length)));
  if (!Array.isArray(header)) throw new Error('Invalid header');
  let at = 4 + length;
  const rows = header.map((r) => {
    if (r.kind === 'video') {
      if (
        !Number.isSafeInteger(r.bytes) ||
        r.bytes < 1 ||
        at + r.bytes > packet.length ||
        typeof r.codec !== 'string' ||
        !r.codec
      )
        throw new Error('Invalid video size');
      const data = packet.slice(at, at + r.bytes);
      at += r.bytes;
      return { kind: r.kind, data, codec: r.codec };
    }
    if (r.kind !== 'observation') {
      if (!['action', 'diagnostic'].includes(r.kind)) throw new Error('Invalid row kind');
      return r;
    }
    if (
      !Number.isSafeInteger(r.depthBytes) ||
      r.depthBytes < 0 ||
      at + r.depthBytes > packet.length
    )
      throw new Error('Invalid image sizes');
    const depth = r.depthBytes ? packet.slice(at, at + r.depthBytes) : undefined;
    at += r.depthBytes;
    return { kind: r.kind, row: r.row, depth };
  });
  if (at !== packet.length) throw new Error('Packet trailing data');
  return rows;
}

export interface PacketSink {
  append(rows: PacketRow[]): Promise<void>;
}
