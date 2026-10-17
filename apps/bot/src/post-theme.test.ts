// ============================================================================
// GENZI POST THEME — Phase 1 acceptance tests
// Run: npx tsx src/post-theme.test.ts   (exits non-zero on failure)
// Covers the plan's Phase 1.4 acceptance check plus every structural promise
// post-theme.ts makes, so drift is caught by a machine, not by memory.
// ============================================================================

import {
  BRAND,
  CATEGORY_THEMES,
  LAYOUT_METRICS,
  SERIES,
  SPACING,
  TYPOGRAPHY,
  VOICE_RULES,
  brandChipLine,
  computeContrast,
  factBlockEntries,
  findMixedScriptSentences,
  hasEthiopic,
  isSeriesDay,
  isStructuralLayout,
  missingRequiredFactFields,
  seriesChipLine,
  seriesFor,
  themeFor,
  validateTheme,
  voiceViolations,
  VOICE_ALLOWLIST,
} from "./post-theme.js";
import { categories } from "./categories.js";
import { buildCaptionParts, buildChannelCaption, buildChannelCaptionPlain } from "./post-buttons.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const status = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// 1. Theme self-validation must be clean (contrast, dominant accent, fields)
// ---------------------------------------------------------------------------
const issues = validateTheme();
check("validateTheme() returns zero errors", issues.filter((i) => i.severity === "error").length === 0,
  issues.map((i) => `${i.severity}:${i.message}`).join(" | "));

// ---------------------------------------------------------------------------
// 2. Registry ↔ theme coverage: every category has exactly one theme
// ---------------------------------------------------------------------------
const registryKeys = categories.map((c) => c.key).sort().join(",");
const themeKeys = Object.keys(CATEGORY_THEMES).sort().join(",");
check("theme covers exactly the registered categories", registryKeys === themeKeys,
  `registry=[${registryKeys}] theme=[${themeKeys}]`);

// ---------------------------------------------------------------------------
// 3. Spec colors are honored where the plan names them
// ---------------------------------------------------------------------------
check("money accent is Gold #FFD84D", CATEGORY_THEMES.money.colors.accent === "#FFD84D");
check("events accent is Magenta #FF6FD8", CATEGORY_THEMES.events.colors.accent === "#FF6FD8");
check("ai-tech accent is Cyan #4FC3F7", CATEGORY_THEMES["ai-tech"].colors.accent === "#4FC3F7");
check("card bg is dark base #0B1020", CATEGORY_THEMES.music.colors.bg === "#0B1020");
check("canvas is 1080×1350", LAYOUT_METRICS.cardWidthPx === 1080 && LAYOUT_METRICS.cardHeightPx === 1350);

// ---------------------------------------------------------------------------
// 4. Layout archetypes match the plan's category table
// ---------------------------------------------------------------------------
const expectedLayouts: Record<string, string> = {
  money: "fact-block", events: "event-block", "ai-tech": "tldr-keypoints",
  music: "media-first", gaming: "media-first", entertainment: "media-first",
  trending: "short-story", community: "short-story", fashion: "short-story",
};
for (const [key, layout] of Object.entries(expectedLayouts)) {
  check(`${key} uses ${layout}`, CATEGORY_THEMES[key as keyof typeof CATEGORY_THEMES].layout === layout);
}

// ---------------------------------------------------------------------------
// 5. One-accent rule: every category declares exactly one dominant accent,
//    and all nine accents are distinct colors (no two categories look alike)
// ---------------------------------------------------------------------------
const accents = new Set(Object.values(CATEGORY_THEMES).map((t) => t.colors.accent));
check("all nine accents are distinct", accents.size === 9, `got ${accents.size}`);
const dominants = Object.values(CATEGORY_THEMES).map((t) => t.dominantAccent);
check("every category declares a dominant accent", dominants.every((d) => ["glow", "grid", "neon-border"].includes(d)));

// ---------------------------------------------------------------------------
// 6. Typography promises: title max 3 lines, chip uppercase, per-tier ratios
// ---------------------------------------------------------------------------
check("title tier caps at 3 lines", TYPOGRAPHY.title.maxLines === 3);
check("chip tier is uppercase", TYPOGRAPHY.chip.uppercase === true);
check("every tier defines a line-height ratio",
  Object.values(TYPOGRAPHY).every((t) => t.lineHeight >= 1 && t.lineHeight <= 2));
check("Ethiopic-heavy title gets generous leading (≥1.2)", TYPOGRAPHY.title.lineHeight >= 1.2);

// ---------------------------------------------------------------------------
// 7. Spacing scale: composites only reference scale steps
// ---------------------------------------------------------------------------
const steps = new Set<number>(Object.values(SPACING));
check("card outer margin is a scale step", steps.has(LAYOUT_METRICS.cardOuterMargin));
check("footer margin is a scale step", steps.has(LAYOUT_METRICS.footerMarginTop));
check("chip padding uses scale steps", steps.has(LAYOUT_METRICS.chipPadX) && steps.has(LAYOUT_METRICS.chipPadY));

// ---------------------------------------------------------------------------
// 8. Brand chip line format: 🇪🇹 GENZI · <emoji> <LABEL>
// ---------------------------------------------------------------------------
check("EN chip format", brandChipLine("money", "en") === `${BRAND.mark} · 💰 OPPORTUNITY`,
  brandChipLine("money", "en"));
check("AM chip format", brandChipLine("events", "am") === `${BRAND.mark} · 🎉 ዝግጅት`,
  brandChipLine("events", "am"));
check("unknown category falls back safely", themeFor("nonsense-xyz").colors.accent.length === 7);

// ---------------------------------------------------------------------------
// 9. Fact blocks: half-filled inputs never render an empty anchor
// ---------------------------------------------------------------------------
const partial = factBlockEntries("money", {
  location: " Addis Ababa ",        // padded value must be trimmed
  deadline: "",                     // blank → dropped
  eligibility: undefined,           // missing → dropped
  link: "genzi.app/apply",
});
check("blank/missing fields dropped", partial.length === 2, JSON.stringify(partial));
check("values trimmed", partial[0]?.value === "Addis Ababa");
check("anchors are spec emoji", partial[0]?.anchor === "📍" && partial[1]?.anchor === "🔗");
check("fully empty input renders nothing", factBlockEntries("money", {}).length === 0);

// ---------------------------------------------------------------------------
// 10. Contrast math sanity + derived accentText always wins its pair
// ---------------------------------------------------------------------------
check("black-on-white contrast ≈ 21", Math.abs(computeContrast("#000000", "#FFFFFF") - 21) < 0.01);
check("same-color contrast = 1", Math.abs(computeContrast("#123456", "#123456") - 1) < 0.001);
for (const t of Object.values(CATEGORY_THEMES)) {
  const r = computeContrast(t.colors.accentText, t.colors.accent);
  check(`accentText readable on ${t.key} accent (≥4.5)`, r >= 4.5, `${r.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 11. Voice rules: mixed-script detector + Ethiopic detection
// ---------------------------------------------------------------------------
check("pure Amharic passes", findMixedScriptSentences("እድል ለሁሉም. ተዋዋይ ነው.") .length === 0);
check("pure English passes", findMixedScriptSentences("A great opportunity for everyone. Apply now.").length === 0);
check("mixed sentence flagged", findMixedScriptSentences("ተማሪዎች apply made ቀርበዋል.").length === 1);
check("allowlist exempts approved loanwords",
  findMixedScriptSentences("አዲስ AI ቴክ መሳሪያ.", ["AI"]).length === 0);
check("hasEthiopic detects Amharic letters", hasEthiopic("ሰላም ኢትዮጵያ"));
check("hasEthiopic ignores Latin/emoji", !hasEthiopic("Hello 🔥 GENZI"));
check("title char cap is 60", VOICE_RULES.maxTitleChars === 60);

// ---------------------------------------------------------------------------
// 12. Structural-layout categories must ship required fields (Phase 5 hook)
// ---------------------------------------------------------------------------
for (const t of Object.values(CATEGORY_THEMES)) {
  if (isStructuralLayout(t.layout)) {
    check(`${t.key}: structural layout declares required fields`, t.factFields.length > 0);
  } else {
    check(`${t.key}: free layout declares no fields`, t.factFields.length === 0);
  }
}

// ---------------------------------------------------------------------------
// 13. Publish gate: missingRequiredFactFields (Phase 5 hook, enforced in publisher)
// ---------------------------------------------------------------------------
check("money blocks empty values",
  missingRequiredFactFields("money", {}).length === CATEGORY_THEMES.money.factFields.length);
check("money blocks blank strings",
  missingRequiredFactFields("money", { location: "  ", deadline: "31 Oct" }).includes("location") &&
  missingRequiredFactFields("money", { location: "Bole", deadline: "", eligibility: "Students", link: "https://x.com/a" }).join() === "deadline");
check("money passes when all filled",
  missingRequiredFactFields("money", { location: "Bole", deadline: "31 Oct", eligibility: "Students", link: "https://t.me/genzi_et" }).length === 0);
check("events blocks missing date/venue/link",
  missingRequiredFactFields("events", { venue: "Friendship Park" }).join() === "date,link");
check("ai-tech blocks missing source link",
  missingRequiredFactFields("ai-tech", {}).join() === "link");
check("free layouts never block",
  ["music", "gaming", "entertainment", "trending", "community", "fashion"].every((k) => missingRequiredFactFields(k, {}).length === 0));
check("unknown category falls back and never blocks",
  missingRequiredFactFields("not-a-category", {}).length === 0);

// ---------------------------------------------------------------------------
// 14. Caption pipeline: fact rows render in HTML and plain twins (WYSIWYG)
// ---------------------------------------------------------------------------
const captionBase = {
  title: "Ethiopian devs: paid GitHub mentorship",
  body: "Twelve seats, weekly reviews.",
  tags: [] as string[],
  author: "Abel",
  publishedAt: new Date("2026-10-16T12:00:00Z"),
  readingMinutes: 1,
  locale: "en" as const,
};
const htmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const moneyCaption = buildChannelCaption({
  ...captionBase,
  category: "money",
  factValues: { location: "Remote", deadline: "31 Oct", eligibility: "Students", link: "https://x.com/a" },
  escapeHtml: htmlEsc,
});
check("HTML caption renders all four anchored fact rows",
  ["📍 <b>Where:</b> Remote", "⏳ <b>Deadline:</b> 31 Oct", "🎯 <b>Who:</b> Students", "🔗 <b>How:</b> https://x.com/a"]
    .every((row) => moneyCaption.includes(row)));
check("HTML caption puts fact rows between title and body",
  moneyCaption.indexOf("GitHub mentorship") < moneyCaption.indexOf("📍 <b>Where:") &&
  moneyCaption.indexOf("🔗 <b>How:") < moneyCaption.indexOf("Twelve seats"));

const partialCaption = buildChannelCaption({
  ...captionBase,
  category: "events",
  factValues: { date: "Sat 24 Oct", venue: "", link: undefined },
  escapeHtml: htmlEsc,
});
check("half-filled block drops empty anchors only",
  partialCaption.includes("🕒 <b>When:</b> Sat 24 Oct") &&
  !partialCaption.includes("Venue") && !partialCaption.includes("Tickets"));

const freeCaption = buildChannelCaption({
  ...captionBase,
  category: "music",
  factValues: { location: "should be ignored" },
  escapeHtml: htmlEsc,
});
check("free layouts never render fact rows", !freeCaption.includes("Where:"));

const noValuesCaption = buildChannelCaption({ ...captionBase, category: "money", escapeHtml: htmlEsc });
check("legacy callers without factValues unaffected", !noValuesCaption.includes("Where:"));

const escapedCaption = buildChannelCaption({
  ...captionBase,
  category: "money",
  factValues: { location: "<script>x</script>", deadline: "31 Oct", eligibility: "All", link: "https://t.me/genzi_et" },
  escapeHtml: htmlEsc,
});
check("fact values are HTML-escaped", escapedCaption.includes("&lt;script&gt;") && !escapedCaption.includes("<script>"));

const plainCaption = buildChannelCaptionPlain({ ...captionBase, category: "money",
  factValues: { location: "Remote", deadline: "31 Oct", eligibility: "Students", link: "https://x.com/a" } });
check("plain twin carries the same rows unstyled",
  plainCaption.includes("📍 Where: Remote") && plainCaption.includes("⏳ Deadline: 31 Oct"));
check("HTML and plain twins agree on row content",
  ["Where", "Deadline", "Who", "How"].every((label) =>
    moneyCaption.includes(label) === plainCaption.includes(label)));

// ---------------------------------------------------------------------------
// 15. Phase 3 — series visual spec (chip, accent, fixed day)
// ---------------------------------------------------------------------------
check("every series has a unique key matching its registry slot",
  Object.values(SERIES).every((s) => s.key in SERIES && s.chip === s.chip.toUpperCase()));
check("every series names an existing category (accent comes from that theme)",
  Object.values(SERIES).every((s) => s.category in CATEGORY_THEMES));
check("series chip line replaces the plain category chip",
  seriesChipLine("monday-money-moves", "money", "en") === `🇪🇹 GENZI · 💸 MONDAY MONEY MOVES`);
check("unknown/missing series keys fall back to the ordinary category chip line",
  seriesChipLine(null, "events", "en") === brandChipLine("events", "en") &&
  seriesChipLine("deleted-series", "music", "en") === brandChipLine("music", "en"));
check("series day contract: Monday Money Moves is fixed to Monday UTC",
  isSeriesDay(seriesFor("monday-money-moves")!, new Date("2026-10-19T00:00:00Z")) && // a Monday
  !isSeriesDay(seriesFor("monday-money-moves")!, new Date("2026-10-20T00:00:00Z")));
check("seriesFor passes through unknown keys as null (rows optional, never empty anchors)",
  seriesFor(undefined) === null && seriesFor("nope") === null);

const seriesCaption = buildChannelCaption({
  ...captionBase,
  category: "money",
  seriesKey: "monday-money-moves",
  factValues: { location: "Remote", deadline: "31 Oct", eligibility: "Students", link: "https://x.com/a" },
  escapeHtml: htmlEsc,
});
check("published caption carries the series chip instead of the category chip",
  seriesCaption.includes("💸 MONDAY MONEY MOVES") && !seriesCaption.includes("· 💰 OPPORTUNITY"));
check("series episode keeps its fact block intact (chip swap changes nothing else)",
  ["📍 <b>Where:</b> Remote", "⏳ <b>Deadline:</b> 31 Oct"].every((row) => seriesCaption.includes(row)));

// ---------------------------------------------------------------------------
// 16. Phase 3 — expandable quotes (long bodies stay short in the feed)
// ---------------------------------------------------------------------------
const longPara = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}: some substantial body text to fill the feed.`).join("\n\n");
// ~1400 chars — past the 700-char feed-visible budget AND its 1.25× trigger, so a
// split is guaranteed; paragraph boundaries near the target make it land early.
const wholeBody = longPara(20);

const shortParts = buildCaptionParts({ ...captionBase, category: "music", expandAfterChars: VOICE_RULES.feedVisibleBodyChars, escapeHtml: htmlEsc });
check("short bodies are never split (hidden part empty, no 'continued' path)",
  shortParts.hiddenBody === "" && shortParts.body === htmlEsc(captionBase.body));

const longParts = buildCaptionParts({ ...captionBase, body: wholeBody, category: "trending", expandAfterChars: VOICE_RULES.feedVisibleBodyChars, escapeHtml: htmlEsc });
check("long bodies move the remainder out of the visible feed",
  longParts.hiddenBody.length > 0 &&
  longParts.body.length <= VOICE_RULES.feedVisibleBodyChars * 1.3);
check("split happens at a paragraph boundary, not mid-sentence",
  !longParts.body.endsWith(" ") && wholeBody.startsWith(longParts.body) &&
  wholeBody.slice(longParts.body.length).trimStart().startsWith(longParts.hiddenBody));
check("visible + hidden rejoin into the original body (nothing lost or duplicated)",
  `${longParts.body}\n\n${longParts.hiddenBody}` === wholeBody);
check("head/tail untouched by splitting (chip, title, footer always in message one)",
  longParts.head.includes("<b>") && longParts.tail.includes("min read"));
check("expandAfterChars unset → legacy behavior, body stays whole",
  buildCaptionParts({ ...captionBase, body: wholeBody, escapeHtml: htmlEsc }).hiddenBody === "");

// ---------------------------------------------------------------------------
// 17. Phase 5 — voice-rule enforcement (declared rules must actually block)
// ---------------------------------------------------------------------------
check("voice: clean post passes",
  voiceViolations({ title: "የገንዘብ ዕድሎች ሳምንቱ", body: "አዲስ የስልክ መተግበሪያ ተመርቋል።\n\nለሁሉም ክፍት ነው።" }).length === 0);

check("voice: over-long title is blocked at the 60-char rule, not the 100-char input cap",
  voiceViolations({ title: "A".repeat(VOICE_RULES.maxTitleChars + 1) }).some((v) => v.startsWith("title")));

check("voice: exactly maxTitleChars passes (boundary)",
  voiceViolations({ title: "B".repeat(VOICE_RULES.maxTitleChars) }).length === 0);

check("voice: mixed Amharic/English sentence is blocked",
  voiceViolations({ title: "OK", body: "ይህ ምርጥ product ነው።" }).some((v) => v.includes("mixed Amharic/English")));

check("voice: brand-allowlisted loanwords pass in an otherwise Amharic sentence",
  voiceViolations({ title: "OK", body: "አዲሱ AI መተግበሪያ ተመርቋል።" }).length === 0 &&
  VOICE_ALLOWLIST.includes("AI"));

check("voice: three sentences in one paragraph breaks one-idea-per-paragraph",
  voiceViolations({ title: "OK", body: "First idea. Second idea. Third idea." }).some((v) => v.includes("one idea per paragraph")));

check("voice: two sentences in one paragraph still pass (limit is 2)",
  voiceViolations({ title: "OK", body: "First idea. Second idea." }).length === 0);

check("voice: missing/empty body never produces violations",
  voiceViolations({ title: "OK" }).length === 0 && voiceViolations({ title: "OK", body: "   " }).length === 0);

check("voice: violation strings are human-readable (wizard shows them verbatim)",
  voiceViolations({ title: "x".repeat(80) }).some((v) => v.includes("limit 60")));

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\n✅ All Phase 1–3 acceptance checks passed." : `\n❌ ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
