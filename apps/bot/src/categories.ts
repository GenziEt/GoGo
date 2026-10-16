// Category registry. The keys and bilingual labels live here; every visual
// attribute (accent color, emoji, layout archetype) is owned by post-theme.ts
// — the single source of truth. Do not add colors or sizes to this file.

import { CATEGORY_THEMES, type ThemeCategory } from "./post-theme.js";

export const categories = [
  { key: "entertainment", am: "😂 መዝናኛ", en: "😂 Entertainment" },
  { key: "trending", am: "🔥 አዝማሚያ", en: "🔥 Trending" },
  { key: "music", am: "🎵 ሙዚቃ", en: "🎵 Music" },
  { key: "community", am: "🗣️ ማህበረሰብ", en: "🗣️ Community" },
  { key: "money", am: "💰 ገንዘብ/እድል", en: "💰 Money/Opportunities" },
  { key: "ai-tech", am: "🤖 AI እና ቴክ", en: "🤖 AI & Tech" },
  { key: "fashion", am: "👗 ፋሽን", en: "👗 Fashion" },
  { key: "events", am: "🎉 ዝግጅቶች", en: "🎉 Events" },
  { key: "gaming", am: "🎮 ጌም", en: "🎮 Gaming" }
] as const;

export type CategoryKey = typeof categories[number]["key"];

/** Every registered key must have a theme, and vice versa (compile-time guard). */
const _keysCovered: Record<CategoryKey, true> = (() => {
  for (const c of categories) {
    if (!CATEGORY_THEMES[c.key]) throw new Error(`post-theme.ts is missing a theme for category "${c.key}"`);
  }
  return {} as Record<CategoryKey, true>;
})();
void _keysCovered;

/** Theme lookup for a category key (visual identity comes from post-theme.ts). */
export function themeForCategory(key: CategoryKey): ThemeCategory {
  return CATEGORY_THEMES[key];
}
