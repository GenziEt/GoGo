// ============================================================================
// GENZI POST THEME — SINGLE SOURCE OF TRUTH (Phase 1 of the Post Experience Plan)
// ============================================================================
// Every visual value for a post — colors, typography sizes, spacing steps,
// corner radii, border weights, glow parameters — is defined HERE and only
// here. Nothing outside this file may hardcode a color, size, or spacing
// value. If a value isn't in this file, it doesn't ship.
//
// Consumers:
//   • categories.ts   — maps each CategoryKey to a ThemeCategory (accent/layout)
//   • post-buttons.ts / telegram-publisher.ts — brand line + fact-block anchors
//   • card renderer (Phase 2, satori/resvg)    — reads tokens directly
//   • theme linter (Phase 5)                  — enforces "no values outside this file"
//
// Amharic note: the Ethiopic script renders denser and taller than Latin at
// the same nominal font size. All type tiers carry explicit line-height
// ratios so titles never clip ል ር ሰ sequences on small phones.
// ============================================================================

import type { CategoryKey } from "./categories.js";

// ----------------------------------------------------------------------------
// 1. Color primitives
// ----------------------------------------------------------------------------
// The ONLY place raw hex literals live. Everything else references these.

/** Shared dark base background for every card and caption panel. */
const BG_DARK = "#0B1020";

/** Body text on the dark base. */
const TEXT_BODY = "#E8ECF4";

/** Secondary/muted text on the dark base (footers, @channel, labels). */
const TEXT_MUTED = "#9AA3B8";

/** Text color guaranteed readable on top of any accent chip (dark-on-bright). */
const ACCENT_TEXT_ON_LIGHT = "#0B1020";

/** Text color for use on dark accents (Rose/Magenta sit mid-luminance). */
const ACCENT_TEXT_ON_DARK = "#FFFFFF";

/** Default accent used when a category key is unknown (should never render; kept contrast-safe). */
const FALLBACK_ACCENT = "#4FC3F7";

// Named category accents (spec colors where given, harmonious picks elsewhere).
const GOLD = "#FFD84D"; // 💰 Money / Opportunities — spec
const MAGENTA = "#FF6FD8"; // 🎉 Events — spec
const CYAN = "#4FC3F7"; // 🤖 AI & Tech — spec
const PURPLE = "#B388FF"; // 🎵 Music
const LIME = "#C6FF4F"; // 🎮 Gaming
const ORANGE = "#FFAB5E"; // 😂 Entertainment
const GREEN = "#5BE58A"; // 🔥 Trending
const BLUE = "#5EA7FF"; // 🗣️ Community
const ROSE = "#FF7D9E"; // 👗 Fashion

// ----------------------------------------------------------------------------
// 2. Contrast check (WCAG relative luminance)
// ----------------------------------------------------------------------------
// Structural guarantee behind the plan's rule: "All text-on-background pairs
// must pass a contrast check." computeContrast is exported so tests and the
// Phase 5 lint step can verify pairs instead of trusting comments.

function channelLinear(c8: number): number {
  const s = c8 / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Relative luminance per WCAG 2.1 from a #RRGGBB string. */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) throw new Error(`relativeLuminance: not a #RRGGBB hex: "${hex}"`);
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return 0.2126 * channelLinear(r) + 0.7152 * channelLinear(g) + 0.0722 * channelLinear(b);
}

/** WCAG contrast ratio between two hex colors: 1..21. */
export function computeContrast(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Minimum contrast required for chip/label text on an accent background. */
export const MIN_CONTRAST_ON_ACCENT = 4.5; // WCAG AA for small text

/** Minimum contrast required for body/muted text on the dark base. */
export const MIN_CONTRAST_ON_BG = 4.5;

/**
 * Pick the better of light/dark text for a given accent. Used when defining
 * categories so accentText is always derived, never hand-guessed.
 */
function contrastCheckedAccentText(accent: string): string {
  const onLight = computeContrast(ACCENT_TEXT_ON_LIGHT, accent);
  const onDark = computeContrast(ACCENT_TEXT_ON_DARK, accent);
  return onLight >= onDark ? ACCENT_TEXT_ON_LIGHT : ACCENT_TEXT_ON_DARK;
}

// ----------------------------------------------------------------------------
// 3. Layout archetypes
// ----------------------------------------------------------------------------
// The plan mandates that categories never all look the same. Each category
// declares which layout family its posts and cards follow.

export type PostLayout =
  /** Fixed structured block with emoji anchors: Where / Deadline / Who / How. */
  | "fact-block"
  /** Date + time + venue block (events read as a schedule, not prose). */
  | "event-block"
  /** TL;DR line up top, then bulleted key points. */
  | "tldr-keypoints"
  /** Short punchy copy; media dominates the card. */
  | "media-first"
  /** Narrative short-form: hook line + 2-3 paragraphs. */
  | "short-story";

/** Whether a layout requires structured wizard fields before publishing. */
export function isStructuralLayout(layout: PostLayout): boolean {
  return layout === "fact-block" || layout === "event-block" || layout === "tldr-keypoints";
}

// ----------------------------------------------------------------------------
// 4. Fact-block anchor set
// ----------------------------------------------------------------------------
// Emoji anchors are fixed by the plan. Structured layouts fill a subset.
// Half-filled blocks fall back gracefully: an anchor with no value is never
// rendered (the renderer filters empty entries via factBlockEntries()).

export type FactAnchor = "📍" | "🕒" | "⏳" | "🎯" | "🔗";

export interface FactFieldSpec {
  key: string; // machine key stored on the post (e.g. "location")
  anchor: FactAnchor;
  labelEn: string;
  labelAm: string;
}

/** Money / Opportunities: Where / Deadline / Who / How (per spec). */
const FACT_FIELDS_MONEY: readonly FactFieldSpec[] = [
  { key: "location", anchor: "📍", labelEn: "Where", labelAm: "የት" },
  { key: "deadline", anchor: "⏳", labelEn: "Deadline", labelAm: "የመጨረሻ ቀን" },
  { key: "eligibility", anchor: "🎯", labelEn: "Who", labelAm: "ለማን" },
  { key: "link", anchor: "🔗", labelEn: "How", labelAm: "እንዴት" },
];

/** Events: date + time + venue. */
const FACT_FIELDS_EVENTS: readonly FactFieldSpec[] = [
  { key: "date", anchor: "🕒", labelEn: "When", labelAm: "መቼ" },
  { key: "venue", anchor: "📍", labelEn: "Venue", labelAm: "ስፍራ" },
  { key: "link", anchor: "🔗", labelEn: "Tickets", labelAm: "ትኬት" },
];

/** AI & Tech: TL;DR + key points uses a link anchor only. */
const FACT_FIELDS_AI_TECH: readonly FactFieldSpec[] = [
  { key: "link", anchor: "🔗", labelEn: "Source", labelAm: "ምንጭ" },
];

// ----------------------------------------------------------------------------
// 5. Category themes
// ----------------------------------------------------------------------------

export interface ThemeCategory {
  key: CategoryKey;
  /** Accent emoji used in the header chip, e.g. "💰". */
  emoji: string;
  /** English chip word, uppercased at render time, e.g. "OPPORTUNITY". */
  chipLabelEn: string;
  /** Amharic chip word, e.g. "እድል". */
  chipLabelAm: string;
  layout: PostLayout;
  /** Structured fields for this layout; empty array = free-text layouts. */
  factFields: readonly FactFieldSpec[];
  colors: {
    /** Shared dark base. Identical across categories by design. */
    bg: string;
    /** This category's accent. */
    accent: string;
    /** Contrast-checked text color for use ON the accent. */
    accentText: string;
    body: string;
    muted: string;
  };
  /**
   * Which single cyberpunk touch dominates this category's card.
   * The one-accent rule: exactly ONE of {glow, grid, neon-border} is dominant
   * per category; the other two are suppressed to near-zero. This keeps the
   * system reading as designed rather than as a gamer banner.
   */
  dominantAccent: "glow" | "grid" | "neon-border";
}

function makeCategory(
  key: CategoryKey,
  emoji: string,
  chipLabelEn: string,
  chipLabelAm: string,
  layout: PostLayout,
  accent: string,
  dominantAccent: ThemeCategory["dominantAccent"],
  factFields: readonly FactFieldSpec[] = [],
): ThemeCategory {
  return {
    key,
    emoji,
    chipLabelEn,
    chipLabelAm,
    layout,
    factFields,
    colors: {
      bg: BG_DARK,
      accent,
      accentText: contrastCheckedAccentText(accent),
      body: TEXT_BODY,
      muted: TEXT_MUTED,
    },
    dominantAccent,
  };
}

export const CATEGORY_THEMES: Readonly<Record<CategoryKey, ThemeCategory>> = {
  money: makeCategory("money", "💰", "OPPORTUNITY", "እድል", "fact-block", GOLD, "neon-border", FACT_FIELDS_MONEY),
  events: makeCategory("events", "🎉", "EVENT", "ዝግጅት", "event-block", MAGENTA, "glow", FACT_FIELDS_EVENTS),
  "ai-tech": makeCategory("ai-tech", "🤖", "AI & TECH", "ኤአይ እና ቴክ", "tldr-keypoints", CYAN, "grid", FACT_FIELDS_AI_TECH),
  music: makeCategory("music", "🎵", "MUSIC", "ሙዚቃ", "media-first", PURPLE, "glow"),
  gaming: makeCategory("gaming", "🎮", "GAMING", "ጌም", "media-first", LIME, "neon-border"),
  entertainment: makeCategory("entertainment", "😂", "FUN", "መዝናኛ", "media-first", ORANGE, "grid"),
  trending: makeCategory("trending", "🔥", "TRENDING", "አዝማሚያ", "short-story", GREEN, "glow"),
  community: makeCategory("community", "🗣️", "COMMUNITY", "ማህበረሰብ", "short-story", BLUE, "neon-border"),
  fashion: makeCategory("fashion", "👗", "FASHION", "ፋሽን", "short-story", ROSE, "grid"),
};

/** Look up a theme by raw category string (API-safe); falls back to community-neutral defaults. */
export function themeFor(category: string): ThemeCategory {
  return CATEGORY_THEMES[category as CategoryKey] ?? {
    ...CATEGORY_THEMES.community,
    key: "community",
    colors: { ...CATEGORY_THEMES.community.colors, accent: FALLBACK_ACCENT },
  };
}

// ----------------------------------------------------------------------------
// 6. Typography scale (card canvas is 1080×1350)
// ----------------------------------------------------------------------------
// Sizes are px on the card canvas; line-height is a RATIO (never improvised
// per-use). Ethiopic glyphs need more leading than Latin at equal size, so
// every tier's ratio is tuned for Amharic density.

export interface TypeTier {
  /** Font size in px on the 1080×1350 card canvas. */
  sizePx: number;
  /** Line-height as a unitless ratio of sizePx. */
  lineHeight: number;
  /** CSS-style font-weight token. */
  weight: number;
  /** Max lines before the renderer must truncate (title tier only enforces). */
  maxLines: number;
  /** Uppercase transform flag (chip tier). */
  uppercase?: boolean;
}

export const TYPOGRAPHY = {
  /** Post title: large, bold, Ethiopic-capable weight, max 3 lines. */
  title: { sizePx: 72, lineHeight: 1.25, weight: 800, maxLines: 3 },
  /** Sub-headline used under TL;DR blocks and story hooks. */
  subtitle: { sizePx: 44, lineHeight: 1.35, weight: 600, maxLines: 2 },
  /** Category chip: medium, uppercase. */
  chip: { sizePx: 34, lineHeight: 1.2, weight: 700, maxLines: 1, uppercase: true },
  /** Fact-block field labels: small, medium weight. */
  factLabel: { sizePx: 28, lineHeight: 1.3, weight: 500, maxLines: 1 },
  /** Fact-block values: slightly larger than labels for scan priority. */
  factValue: { sizePx: 34, lineHeight: 1.3, weight: 700, maxLines: 2 },
  /** Body copy inside captions/cards. */
  body: { sizePx: 36, lineHeight: 1.5, weight: 400, maxLines: 6 },
  /** Footer / @channel: small, muted. */
  footer: { sizePx: 28, lineHeight: 1.3, weight: 400, maxLines: 1 },
} as const satisfies Record<string, TypeTier>;

// ----------------------------------------------------------------------------
// 7. Spacing scale
// ----------------------------------------------------------------------------
// A fixed four-step scale. Card outer margin, chip padding, title block
// padding, and footer margin ALL reference these — no in-between values.

export const SPACING = {
  /** tight: within-component gaps (label→value, chip inner padding). */
  tight: 12,
  /** base: default gap between sibling elements. */
  base: 24,
  /** loose: block separations (title block → fact block). */
  loose: 48,
  /** section: major regions (content → footer, card outer margin). */
  section: 72,
} as const;

export type SpacingStep = keyof typeof SPACING;

/** Named composite paddings/margins — still just scale references. */
export const LAYOUT_METRICS = {
  cardWidthPx: 1080,
  cardHeightPx: 1350,
  cardOuterMargin: SPACING.section,
  chipPadX: SPACING.base,
  chipPadY: SPACING.tight,
  titleBlockPad: SPACING.loose,
  factRowGap: SPACING.base,
  footerMarginTop: SPACING.section,
  logoSizePx: 96,
} as const;

// ----------------------------------------------------------------------------
// 8. Shape & line tokens
// ----------------------------------------------------------------------------

export const SHAPES = {
  /** Corner radius: card shell. */
  radiusCard: 48,
  /** Corner radius: category chip (pill-ish). */
  radiusChip: 999,
  /** Corner radius: fact-block panels. */
  radiusPanel: 24,
  /** Border thickness for the neon accent treatment. */
  neonBorderWidth: 6,
  /** Glow blur radius (used when glow is the dominant accent). */
  glowBlurRadius: 120,
  /** Glow opacity (kept subtle — a tint, not a spotlight). */
  glowOpacity: 0.28,
  /** Grid texture opacity (kept low by spec). */
  gridTextureOpacity: 0.06,
  /** Grid cell size for the texture. */
  gridSizePx: 60,
  /** Divider width used in Telegram caption separators (Phase 3 tuning input). */
  dividerWidth: 2,
} as const;

/**
 * Caption divider length in dash characters. The old caption hardcoded a
 * 12-dash string in post-buttons.ts; it now derives from this token so the
 * Phase 3 spacing pass can retune it in one place.
 */
export const CAPTION_DIVIDER_WIDTH = SHAPES.dividerWidth * 6;

/**
 * Per-treatment multipliers implementing the one-accent rule.
 * The renderer applies the category's dominantAccent at full strength and
 * suppresses the other two to their "subdued" values, so only one touch leads.
 */
export const ACCENT_TREATMENTS = {
  glow: { strong: SHAPES.glowOpacity, subdued: 0.08 },
  grid: { strong: SHAPES.gridTextureOpacity, subdued: 0.02 },
  "neon-border": { strong: SHAPES.neonBorderWidth, subdued: 0 },
} as const;

// ----------------------------------------------------------------------------
// 9. Brand voice rules (machine-checkable constants)
// ----------------------------------------------------------------------------
// These are RULES, not suggestions. The wizard (Phase 5 schema validation)
// imports them and refuses to publish violating posts.

export const VOICE_RULES = {
  /** Titles must be under this many characters (both scripts counted equally). */
  maxTitleChars: 60,
  /** Exactly one call-to-action per post. */
  maxCallsToAction: 1,
  /** Paragraphs hold one idea each — enforced as max sentences per paragraph. */
  maxSentencesPerParagraph: 2,
  /** Amharic and English never mix within a single sentence (checked per-sentence). */
  forbidMixedScriptSentences: true,
} as const;

/**
 * True if text contains Ethiopic script. The Ge'ez letter block is U+1200-U+137F.
 * Amharic titles live entirely in this block (the old U+2D80 range never
 * matched real Amharic and silently broke the mixed-script voice rule).
 */
export function hasEthiopic(text: string): boolean {
  return /[\u{1200}-\u{137F}\u{1E7E0}-\u{1E7FF}]/u.test(text);
}

/** True if text contains basic Latin letters (excluding emoji/latin-1 noise). */
export function hasLatinWords(text: string): boolean {
  return /[A-Za-z]{2,}/.test(text);
}

/**
 * Rule: Amharic and English never mixed in the same sentence.
 * Splits on sentence terminators (. ። ! ? …) and flags any sentence containing
 * both a run of Ethiopic and a run of 2+ Latin letters. Common loanwords are
 * unavoidable in tech/fashion copy, so `allowlist` lets a brand-approved set
 * (e.g. "AI", "app") pass. Returns offending sentence indices; empty = valid.
 */
export function findMixedScriptSentences(text: string, allowlist: readonly string[] = []): number[] {
  const offenders: number[] = [];
  const sentences = text.split(/(?<=[.!…።])\s+/);
  let index = 0;
  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    const stripped = allowlist.reduce((acc, word) => acc.replace(new RegExp(word, "gi"), ""), sentence);
    if (hasEthiopic(stripped) && hasLatinWords(stripped)) offenders.push(index);
    index++;
  }
  return offenders;
}

/**
 * Wizard gate for structural categories (Phase 1.1 layout table). A post in a
 * fact-block / event-block / tldr-keypoints category may not publish while any
 * required fact field is missing or blank — this is the rule Phase 5's schema
 * validation enforces at the wizard; here it lives in the theme so the two can
 * never disagree about which fields are required. Free layouts (media-first,
 * short-story) have no required fields and always pass.
 */
export function missingRequiredFactFields(
  category: string,
  values: Record<string, string | undefined>,
): string[] {
  const theme = themeFor(category);
  if (!isStructuralLayout(theme.layout)) return [];
  const missing: string[] = [];
  for (const field of theme.factFields) {
    const raw = values[field.key];
    if (raw === undefined || raw.trim() === "") missing.push(field.key);
  }
  return missing;
}

// ----------------------------------------------------------------------------
// 10. Brand line + helpers
// ----------------------------------------------------------------------------

export const BRAND = {
  /** Flag + name prefix for the header chip line. */
  mark: "🇪🇹 GENZI",
  /** Channel handle shown in card footers. */
  channelHandle: "@genzi_et",
} as const;

// ----------------------------------------------------------------------------
// 10b. Fact-block defaults (Phase 5: "Defaults are applied where sensible")
// ----------------------------------------------------------------------------
// Auto-filled values that satisfy a required field WITHOUT inventing content:
//   • money "link" / events "tickets" ← the post's own platform link (the How
//     to apply IS the link the author pasted).
//   • ai-tech "source" ← same platform link, else the official channel link
//     (a tech story without a source is gossip — this stays a required field).
// Anything else must come from the author via the wizard's facts step.

export function factDefaults(
  category: string,
  ctx: { linkUrl?: string | null },
): Record<string, string> {
  const out: Record<string, string> = {};
  const theme = themeFor(category);
  if (!isStructuralLayout(theme.layout)) return out;
  for (const field of theme.factFields) {
    if (field.key === "link" && ctx.linkUrl) out.link = ctx.linkUrl;
    if (field.key === "source" && ctx.linkUrl) out.source = ctx.linkUrl;
  }
  return out;
}

/**
 * Required fields still missing AFTER sensible defaults are applied — the exact
 * list the wizard asks the author to fill, and the same computation the publish
 * gate uses, so the question set and the gate can never disagree.
 */
export function missingFactFieldsAfterDefaults(
  category: string,
  values: Record<string, string | undefined>,
  ctx: { linkUrl?: string | null },
): string[] {
  const merged = { ...factDefaults(category, ctx), ...values };
  return missingRequiredFactFields(category, merged);
}

/**
 * Header chip for a post, e.g. "🇪🇹 GENZI · 💰 OPPORTUNITY" (en) or
 * "🇪🇹 GENZI · 💰 እድል" (am). Every post gets its category's chip — never the
 * same bare line on every post.
 */
export function brandChipLine(category: string, locale: "en" | "am"): string {
  const theme = themeFor(category);
  const label = locale === "am" ? theme.chipLabelAm : theme.chipLabelEn.toUpperCase();
  return `${BRAND.mark} · ${theme.emoji} ${label}`;
}

/**
 * Graceful fact-block fallback: map a post's filled fields into renderable
 * rows, dropping any anchor whose value is missing/blank. Never returns an
 * entry that would render an empty anchor or broken panel.
 */
export function factBlockEntries(
  category: string,
  values: Record<string, string | undefined>,
): Array<{ anchor: FactAnchor; label: string; value: string }> {
  const theme = themeFor(category);
  const out: Array<{ anchor: FactAnchor; label: string; value: string }> = [];
  for (const field of theme.factFields) {
    const raw = values[field.key];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (!value) continue;
    out.push({ anchor: field.anchor, label: field.labelEn, value });
  }
  return out;
}

/** Amharic-label variant of factBlockEntries for AM posts. */
export function factBlockEntriesAm(
  category: string,
  values: Record<string, string | undefined>,
): Array<{ anchor: FactAnchor; label: string; value: string }> {
  const theme = themeFor(category);
  const out: Array<{ anchor: FactAnchor; label: string; value: string }> = [];
  for (const field of theme.factFields) {
    const raw = values[field.key];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (!value) continue;
    out.push({ anchor: field.anchor, label: field.labelAm, value });
  }
  return out;
}

// ----------------------------------------------------------------------------
// 11. Self-validation (runs at import time in dev/test; also called by lint)
// ----------------------------------------------------------------------------

export interface ThemeValidationIssue {
  severity: "error" | "warn";
  message: string;
}

/**
 * Verify the theme's own promises:
 *  • every accentText passes MIN_CONTRAST_ON_ACCENT against its accent
 *  • body & muted text pass MIN_CONTRAST_ON_BG against the shared bg
 *  • every category declares exactly one dominantAccent
 *  • structural layouts declare at least one fact field
 */
export function validateTheme(): ThemeValidationIssue[] {
  const issues: ThemeValidationIssue[] = [];
  for (const theme of Object.values(CATEGORY_THEMES)) {
    const { bg, accent, accentText, body, muted } = theme.colors;
    const chipRatio = computeContrast(accentText, accent);
    if (chipRatio < MIN_CONTRAST_ON_ACCENT) {
      issues.push({
        severity: "error",
        message: `${theme.key}: accentText on accent contrast ${chipRatio.toFixed(2)} < ${MIN_CONTRAST_ON_ACCENT}`,
      });
    }
    for (const [name, fg] of [["body", body], ["muted", muted]] as const) {
      const ratio = computeContrast(fg, bg);
      if (ratio < MIN_CONTRAST_ON_BG) {
        issues.push({
          severity: "error",
          message: `${theme.key}: ${name}-on-bg contrast ${ratio.toFixed(2)} < ${MIN_CONTRAST_ON_BG}`,
        });
      }
    }
    if (isStructuralLayout(theme.layout) && theme.factFields.length === 0) {
      issues.push({ severity: "error", message: `${theme.key}: structural layout with no fact fields` });
    }
    if (!theme.dominantAccent) {
      issues.push({ severity: "error", message: `${theme.key}: missing dominantAccent` });
    }
  }
  const distinctAccents = new Set(Object.values(CATEGORY_THEMES).map((t) => t.colors.accent));
  if (distinctAccents.size !== Object.keys(CATEGORY_THEMES).length) {
    issues.push({ severity: "warn", message: "Two categories share the same accent color" });
  }
  return issues;
}
