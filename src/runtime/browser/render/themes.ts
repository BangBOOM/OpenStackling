import island from './themes/island';
import studio from './themes/studio';
import type { ThemePlugin } from './theme';
import type { ThemeId } from '../../theme-catalog';
export const themes: Record<ThemeId, ThemePlugin> = { island, studio };
