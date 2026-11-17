// Pixel transforms shared by the synchronous capture path and the encode worker.
// GL readback is bottom-up; the protocol expects top-left rows.
export function flipRows(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(rgba.length),
    row = width * 4;
  for (let y = 0; y < height; y++)
    out.set(rgba.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return out;
}

// The depth pass packs millimetres into RG (low byte, high byte), so the u16
// payload is produced from the red and green channels of the RGBA readback.
export function unpackDepth(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 2);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const src = ((height - 1 - y) * width + x) * 4,
        dst = (y * width + x) * 2;
      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
    }
  return out;
}
