export const positive = (v: number, name: string) => {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid ${name}`);
};
export const integer = (v: number, name: string) => {
  positive(v, name);
  if (!Number.isInteger(v)) throw new Error(`Invalid ${name}`);
};
export const finiteTree = (v: unknown) => {
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Non-finite configuration');
  if (v && typeof v === 'object') Object.values(v).forEach(finiteTree);
};
