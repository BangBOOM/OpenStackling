export const DATASET_FORMAT = { kind: 'dataset', schemaVersion: 10 } as const;
export const EVALUATION_FORMAT = { kind: 'evaluation', schemaVersion: 2 } as const;
export type RecordFormat = typeof DATASET_FORMAT | typeof EVALUATION_FORMAT;
export function matchesFormat(
  value: { kind?: unknown; schemaVersion?: unknown },
  format: RecordFormat,
) {
  return value.kind === format.kind && value.schemaVersion === format.schemaVersion;
}
