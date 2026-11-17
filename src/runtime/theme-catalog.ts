export const THEME_IDS = ['island', 'studio'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const THEME_VERSIONS: Record<ThemeId, string> = {
  island: '4.3.0',
  studio: '4.3.0',
};
export function validateTheme(id: string): asserts id is ThemeId {
  if (!THEME_IDS.includes(id as ThemeId)) throw new Error(`Unknown theme: ${id}`);
}
