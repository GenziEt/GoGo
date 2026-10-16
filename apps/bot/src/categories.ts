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
