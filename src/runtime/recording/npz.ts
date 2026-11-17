import { unzipSync, zip } from 'fflate';
// Minimal npz (zip of npy 1.0 members) support. All platforms we target are
// little-endian, so npy payloads are written and read without byte swapping.
export type NpyMember = { descr: string; shape: number[]; data: NpyValue };
export type NpyValue = Float64Array | BigInt64Array | Uint16Array | Uint8Array;
const DESCRIPTORS: Record<
  string,
  | Uint8ArrayConstructor
  | Uint16ArrayConstructor
  | BigInt64ArrayConstructor
  | Float64ArrayConstructor
> = {
  '<f8': Float64Array,
  '<i8': BigInt64Array,
  '<u2': Uint16Array,
  '|u1': Uint8Array,
};
export function npy(descr: string, shape: number[], data: NpyValue): Uint8Array {
  if (data.byteLength !== shape.reduce((a, b) => a * b, 1) * data.BYTES_PER_ELEMENT)
    throw new Error(`npy size mismatch for ${descr} ${JSON.stringify(shape)}`);
  const dict = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  let header = dict.length + 1; // including the terminating newline
  const padded = 10 + header;
  header += (64 - (padded % 64)) % 64;
  const out = new Uint8Array(10 + header + data.byteLength);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x01, 0x00]);
  new DataView(out.buffer).setUint16(8, header, true);
  const text = `${dict}${' '.repeat(header - dict.length - 1)}\n`;
  out.set(new TextEncoder().encode(text), 10);
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 10 + header);
  return out;
}
export function writeNpz(members: Record<string, NpyMember>): Promise<Uint8Array> {
  // Fixed mtime keeps npz bytes deterministic across runs and workers. fflate
  // deflates large members on a worker thread, so this does not block Node.
  return new Promise((resolve, reject) => {
    zip(
      Object.fromEntries(
        Object.entries(members).map(([k, v]) => [`${k}.npy`, npy(v.descr, v.shape, v.data)]),
      ),
      { mtime: new Date(Date.UTC(2000, 0, 1)) },
      (error, data) => (error ? reject(error) : resolve(data)),
    );
  });
}
export function readNpz(
  bytes: Uint8Array,
): Record<string, { descr: string; shape: number[]; data: NpyValue }> {
  const members: Record<string, { descr: string; shape: number[]; data: NpyValue }> = {};
  for (const [name, raw] of Object.entries(unzipSync(bytes))) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (
      raw.length < 12 ||
      raw[0] !== 0x93 ||
      raw[1] !== 0x4e ||
      raw[2] !== 0x55 ||
      raw[3] !== 0x4d ||
      raw[4] !== 0x50 ||
      raw[5] !== 0x59
    )
      throw new Error(`Invalid npy member: ${name}`);
    const headerLength = view.getUint16(8, true);
    const header = new TextDecoder().decode(raw.subarray(10, 10 + headerLength));
    const descr = header.match(/'descr': '([^']+)'/)?.[1];
    const shape = header.match(/'shape': \(([^)]*)\)/)?.[1];
    if (!descr || shape === undefined) throw new Error(`Invalid npy header: ${name}`);
    const constructor = DESCRIPTORS[descr];
    if (!constructor) throw new Error(`Unsupported npy dtype: ${descr}`);
    const dims = shape
      .trim()
      .replace(/,$/, '')
      .split(',')
      .filter((s) => s.trim())
      .map(Number);
    const offset = 10 + headerLength;
    members[name.replace(/\.npy$/, '')] = {
      descr,
      shape: dims,
      data: new constructor(raw.buffer.slice(offset, offset + raw.length - offset)),
    };
  }
  return members;
}
export const CONTROLLERS = ['teacher', 'external-policy', 'manual', 'replay', 'evaluation-hold'];
export const PHASES = [
  'settle',
  'approach',
  'descend',
  'close',
  'lift',
  'carry',
  'place',
  'open',
  'retreat',
  'verify',
  'success',
  'failed',
  'stopped',
  'idle',
  'manual',
  'external-policy',
  'replay',
  'replay-hold',
  'evaluation-hold',
];
export const controllerEnum = (name: string) => {
  const index = CONTROLLERS.indexOf(name);
  if (index < 0) throw new Error(`Unknown controller: ${name}`);
  return index;
};
export const phaseEnum = (name: string) => {
  const index = PHASES.indexOf(name);
  if (index < 0) throw new Error(`Unknown phase: ${name}`);
  return index;
};
