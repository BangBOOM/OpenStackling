import island from './browser/render/themes/island.ts?raw';
import studio from './browser/render/themes/studio.ts?raw';
import { THEME_IDS, THEME_VERSIONS, type ThemeId } from './theme-catalog';
export type AppearanceIdentity = { id: string; version: string; contentHash: string };
const sources = { island, studio };
const identities = Object.fromEntries(
  await Promise.all(
    THEME_IDS.map(async (id) => {
      const source = sources[id];
      const version = THEME_VERSIONS[id];
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      const contentHash = Array.from(new Uint8Array(bytes), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('');
      return [id, { id, version, contentHash }];
    }),
  ),
) as Record<ThemeId, AppearanceIdentity>;
export function appearanceIdentity(id: ThemeId): AppearanceIdentity {
  return { ...identities[id] };
}
export function sameAppearance(a: AppearanceIdentity, b: AppearanceIdentity) {
  return a.id === b.id && a.version === b.version && a.contentHash === b.contentHash;
}
