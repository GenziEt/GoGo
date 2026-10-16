// ============================================================================
// GENZI BRANDED CARD RENDERER — Phase 2 of the Post Experience Plan
// ============================================================================
// Server-side generation of the 1080×1350 branded image card:
//   satori (HTML/CSS → SVG) + @resvg/resvg-js (SVG → PNG).
// No paid API. Fonts are BUNDLED in apps/bot/assets/fonts and loaded from
// disk once per process — never fetched at runtime.
//
// Every visual value comes from post-theme.ts (single source of truth).
// This file hardcodes zero colors, sizes, or spacing.
//
// The one-accent rule (plan §2.2): only ONE of {glow, grid texture, neon
// border} acts as the dominant accent per category; the other two render at
// their subdued token values. Which treatment dominates is declared by each
// theme's `dominantAccent` field — the renderer just obeys it.
//
// Failure contract (plan §2.3): renderCard never throws to the caller on
// internal errors — it returns null so the publisher can fall back to
// text-only. Publishing is never blocked by the renderer.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

import {
  ACCENT_TREATMENTS,
  BRAND,
  LAYOUT_METRICS,
  SHAPES,
  SPACING,
  TYPOGRAPHY,
  factBlockEntries,
  themeFor,
} from "./post-theme.js";

// ----------------------------------------------------------------------------
// Inputs & outputs
// ----------------------------------------------------------------------------

export interface CardInput {
  /** Cache key. Required — cards are cached by post slug (plan §2.3). */
  slug: string;
  title: string;
  category: string;
  locale: "en" | "am";
  /** Structured fact values (Where / Deadline / Who …). Empty entries never render. */
  factValues?: Record<string, string | undefined> | undefined;
  /** Optional body line shown under the title for short-story layouts. */
  subtitle?: string;
}

/** A render result ready to attach to a Telegram message. */
export interface CardPng {
  png: Buffer;
  widthPx: number;
  heightPx: number;
  /** Cache metadata — true when served from disk cache instead of rendering. */
  fromCache: boolean;
}

// ----------------------------------------------------------------------------
// Bundled fonts (loaded once, kept in memory)
// ----------------------------------------------------------------------------
// One family ("GENZI") with weight slots:
//   400 = Inter Regular      (body)         — Ethiopic glyphs fall through
//   500 = Inter Medium       (fact labels)     to Noto Sans Ethiopic below
//   600 = Inter SemiBold…    (we use Bold 700 as its stand-in slot)
//   700 = Inter Bold         (chip / fact values / Ethiopic bold)
//   800 = Inter ExtraBold    (titles — heavier weight so Amharic reads designed)
// Plus the full Noto Sans Ethiopic set at 400/700 so ል ር ሰ sequences and their
// ligatures resolve regardless of which Latin weight is active. Subsetting is
// NOT applied — full TTFs guarantee Ethiopic clusters never clip (plan §2.4).

interface FontSlot {
  name: string;
  /** Satori accepts numeric CSS weights (1–1000). */
  weight: number;
  file: string;
}

const FONT_SLOTS: readonly FontSlot[] = [
  { name: "GENZI", weight: 400, file: "Inter-Regular.ttf" },
  { name: "GENZI", weight: 500, file: "Inter-Medium.ttf" },
  { name: "GENZI", weight: 700, file: "Inter-Bold.ttf" },
  { name: "GENZI", weight: 800, file: "Inter-Bold.ttf" }, // stand-in for ExtraBold
  { name: "Ethiopic", weight: 400, file: "NotoSansEthiopic-Regular.ttf" },
  { name: "Ethiopic", weight: 700, file: "NotoSansEthiopic-Bold.ttf" },
];

let fontDataPromise: Promise<Array<{ name: string; data: ArrayBuffer; weight: number; style: "normal" }>> | null = null;

async function loadFonts() {
  if (!fontDataPromise) {
    const dir = path.join(assetsDir(), "fonts");
    fontDataPromise = Promise.all(
      FONT_SLOTS.map(async (slot) => {
        const buf = await fs.promises.readFile(path.join(dir, slot.file));
        return {
          name: slot.name,
          data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
          weight: slot.weight,
          style: "normal" as const,
        };
      }),
    );
  }
  return fontDataPromise;
}

function assetsDir(): string {
  // Resolve relative to this module so it works from src/ (tsx) and dist/ (tsc).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "assets");
}

// ----------------------------------------------------------------------------
// Disk cache (plan §2.3 "cached by post slug", §2.4 "cache aggressively")
// ----------------------------------------------------------------------------
// Render free tier has limited memory and slow cold starts, so rendered PNGs
// persist to disk and survive restarts. In-process Map avoids even the stat().

const CACHE_DIR_DEFAULT = path.resolve(assetsDir(), "..", ".card-cache");
const cacheDir = () => process.env.GENZI_CARD_CACHE_DIR ?? CACHE_DIR_DEFAULT;
const memoryCache = new Map<string, Buffer>();

function cacheFile(slug: string): string {
  // Slugs come from our own schema ([a-z0-9-]); sanitize defensively anyway.
  const safe = slug.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return path.join(cacheDir(), `${safe}.png`);
}

async function readCache(slug: string): Promise<Buffer | null> {
  const mem = memoryCache.get(slug);
  if (mem) return mem;
  try {
    const buf = await fs.promises.readFile(cacheFile(slug));
    memoryCache.set(slug, buf);
    return buf;
  } catch {
    return null;
  }
}

async function writeCache(slug: string, png: Buffer): Promise<void> {
  memoryCache.set(slug, png);
  try {
    await fs.promises.mkdir(cacheDir(), { recursive: true });
    await fs.promises.writeFile(cacheFile(slug), png);
  } catch {
    // Cache write failure must never block publishing — the in-memory copy
    // already exists for this process lifetime.
  }
}

/** Drop a cached card (call when a post is edited/re-published under the same slug). */
export async function invalidateCard(slug: string): Promise<void> {
  memoryCache.delete(slug);
  try {
    await fs.promises.unlink(cacheFile(slug));
  } catch {
    /* not on disk — fine */
  }
}

// ----------------------------------------------------------------------------
// Text helpers (theme-driven, no magic numbers)
// ----------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Truncate to the title tier's maxLines at a conservative characters-per-line
 * estimate derived from the token itself (canvas width minus outer margins,
 * divided by an average glyph advance ≈ sizePx × 0.52). Satori cannot measure
 * wrapped lines, so we bound input rather than rely on overflow hidden.
 */
export function clampTitle(title: string, maxCharsTotal?: number): string {
  const t = TYPOGRAPHY.title;
  const innerWidth = LAYOUT_METRICS.cardWidthPx - LAYOUT_METRICS.cardOuterMargin * 2;
  const approxCharsPerLine = Math.floor(innerWidth / (t.sizePx * 0.52));
  const budget = maxCharsTotal ?? approxCharsPerLine * t.maxLines;
  const clean = title.trim();
  if (clean.length <= budget) return clean;
  return `${clean.slice(0, budget - 1).trimEnd()}…`;
}

// ----------------------------------------------------------------------------
// Layout builders — one per archetype (plan lever #2: categories never look alike)
// ----------------------------------------------------------------------------

interface Block {
  type: "div";
  props: { style: Record<string, unknown>; children: Array<Block | string> };
}

function div(style: Record<string, unknown>, ...children: Array<Block | string>): Block {
  return { type: "div", props: { style, children } };
}

/** Shared non-accent colors are identical across categories by design (plan §1.2);
 * reading them from any theme keeps post-theme.ts the single source of truth. */
const BASE = themeFor("community");

function chipBlock(category: string, locale: "en" | "am"): Block {
  const theme = themeFor(category);
  const label = locale === "am" ? theme.chipLabelAm : theme.chipLabelEn.toUpperCase();
  const chip = TYPOGRAPHY.chip;
  return div(
    {
      display: "flex",
      alignItems: "center",
      backgroundColor: theme.colors.accent,
      color: theme.colors.accentText,
      borderRadius: `${SHAPES.radiusChip}px`,
      padding: `${LAYOUT_METRICS.chipPadY}px ${LAYOUT_METRICS.chipPadX}px`,
      fontSize: `${chip.sizePx}px`,
      fontWeight: chip.weight,
      lineHeight: chip.lineHeight,
      letterSpacing: `${SHAPES.letterSpacingChip}px`,
    },
    `${theme.emoji} ${escapeHtml(label)}`,
  );
}

function titleBlock(title: string): Block {
  const t = TYPOGRAPHY.title;
  return div(
    {
      fontSize: `${t.sizePx}px`,
      fontWeight: t.weight,
      lineHeight: String(t.lineHeight),
      color: BASE.colors.title,
      fontFamily: "GENZI, Ethiopic",
      marginTop: `${SPACING.loose}px`,
    },
    escapeHtml(clampTitle(title)),
  );
}

function factPanelBlock(category: string, values: Record<string, string | undefined>, locale: "en" | "am"): Block | null {
  const theme = themeFor(category);
  // factBlockEntries already drops empty anchors — graceful fallback (plan §Phase 3
  // rule shared here: never render an empty anchor or broken panel). Same entries
  // for both locales; only the label wording differs (amLabel below).
  const entries = factBlockEntries(category, values);
  if (entries.length === 0) return null;
  const label = TYPOGRAPHY.factLabel;
  const value = TYPOGRAPHY.factValue;
  const rows: Block[] = entries.map((e) =>
    div(
      {
        display: "flex",
        flexDirection: "column",
        gap: `${SPACING.tight}px`,
        flex: "1 1 40%",
      },
      div(
        {
          fontSize: `${label.sizePx}px`,
          fontWeight: label.weight,
          lineHeight: String(label.lineHeight),
          color: theme.colors.muted,
          textTransform: "uppercase",
          letterSpacing: `${SHAPES.letterSpacingLabel}px`,
        },
        `${e.anchor} ${escapeHtml(locale === "am" ? amLabel(category, e.label) : e.label)}`,
      ),
      div(
        {
          fontSize: `${value.sizePx}px`,
          fontWeight: value.weight,
          lineHeight: String(value.lineHeight),
          color: theme.colors.body,
          fontFamily: "GENZI, Ethiopic",
        },
        escapeHtml(e.value),
      ),
    ),
  );
  return div(
    {
      display: "flex",
      flexWrap: "wrap",
      gap: `${LAYOUT_METRICS.factRowGap}px`,
      backgroundColor: theme.colors.panelBg,
      border: `${SHAPES.dividerWidth}px solid ${theme.colors.panelBorder}`,
      borderRadius: `${SHAPES.radiusPanel}px`,
      padding: `${SPACING.loose}px`,
      marginTop: `${SPACING.loose}px`,
    },
    ...rows,
  );
}

/** Map English fact labels back to their Amharic spec counterparts. */
function amLabel(category: string, labelEn: string): string {
  const theme = themeFor(category);
  const field = theme.factFields.find((f) => f.labelEn === labelEn);
  return field ? field.labelAm : labelEn;
}

function tldrBlock(body: string): Block {
  const t = TYPOGRAPHY.subtitle;
  return div(
    {
      display: "flex",
      flexDirection: "column",
      gap: `${SPACING.base}px`,
      marginTop: `${SPACING.loose}px`,
    },
    div(
      {
        fontSize: `${TYPOGRAPHY.factLabel.sizePx}px`,
        fontWeight: TYPOGRAPHY.factLabel.weight,
        color: BASE.colors.title,
        letterSpacing: `${SHAPES.letterSpacingChip}px`,
      },
      "TL;DR",
    ),
    div(
      {
        fontSize: `${t.sizePx}px`,
        fontWeight: t.weight,
        lineHeight: String(t.lineHeight),
        color: BASE.colors.body,
        fontFamily: "GENZI, Ethiopic",
      },
      escapeHtml(body.trim()),
    ),
  );
}

function footerBlock(): Block {
  const f = TYPOGRAPHY.footer;
  const theme = themeFor("community");
  return div(
    {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: "auto",
      paddingTop: `${LAYOUT_METRICS.footerMarginTop}px`,
      fontSize: `${f.sizePx}px`,
      fontWeight: f.weight,
      lineHeight: String(f.lineHeight),
      color: theme.colors.muted,
    },
    escapeHtml(BRAND.mark),
    escapeHtml(BRAND.channelHandle),
  );
}

// ----------------------------------------------------------------------------
// Accent treatments (one-accent rule lives here, values live in the theme)
// ----------------------------------------------------------------------------

function glowLayer(accent: string, opacity: number): Block {
  // Soft category-colored radial glow near the top-right of the card.
  return div(
    {
      position: "absolute",
      top: `-${SHAPES.glowBlurRadius}px`,
      right: `-${SHAPES.glowBlurRadius}px`,
      width: `${SHAPES.glowBlurRadius * 6}px`,
      height: `${SHAPES.glowBlurRadius * 6}px`,
      borderRadius: "50%",
      background: `radial-gradient(circle, ${accent} 0%, transparent 70%)`,
      opacity,
    },
  );
}

function gridLayer(accent: string, opacity: number): Block {
  const cell = SHAPES.gridSizePx;
  const line = `${accent}${Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0")}`;
  return div(
    {
      position: "absolute",
      top: "0",
      left: "0",
      width: `${LAYOUT_METRICS.cardWidthPx}px`,
      height: `${LAYOUT_METRICS.cardHeightPx}px`,
      backgroundImage: `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`,
      backgroundSize: `${cell}px ${cell}px`,
    },
  );
}

function neonBorder(active: boolean, accent: string): Record<string, unknown> {
  if (!active) return {};
  return {
    border: `${ACCENT_TREATMENTS["neon-border"].strong}px solid ${accent}`,
  };
}

// ----------------------------------------------------------------------------
// Card assembly
// ----------------------------------------------------------------------------

export function buildCardElement(input: CardInput): Block {
  const theme = themeFor(input.category);
  const { bg, accent } = theme.colors;
  const m = LAYOUT_METRICS;

  const glowOpacity =
    theme.dominantAccent === "glow" ? ACCENT_TREATMENTS.glow.strong : ACCENT_TREATMENTS.glow.subdued;
  const gridOpacity =
    theme.dominantAccent === "grid" ? ACCENT_TREATMENTS.grid.strong : ACCENT_TREATMENTS.grid.subdued;
  const borderActive = theme.dominantAccent === "neon-border";

  const contentChildren: Block[] = [
    div(
      { display: "flex", justifyContent: "space-between", alignItems: "center" },
      chipBlock(input.category, input.locale),
      div(
        {
          width: `${m.logoSizePx}px`,
          height: `${m.logoSizePx}px`,
          display: "flex",
        },
        logoImage(),
      ),
    ),
    titleBlock(input.title),
  ];

  switch (theme.layout) {
    case "fact-block":
    case "event-block": {
      const panel = factPanelBlock(input.category, input.factValues ?? {}, input.locale);
      if (panel) contentChildren.push(panel);
      break;
    }
    case "tldr-keypoints": {
      const panel = factPanelBlock(input.category, input.factValues ?? {}, input.locale);
      if (input.subtitle?.trim()) contentChildren.push(tldrBlock(input.subtitle));
      if (panel) contentChildren.push(panel);
      break;
    }
    case "media-first": {
      if (input.subtitle?.trim()) {
        const s = TYPOGRAPHY.subtitle;
        contentChildren.push(
          div(
            {
              marginTop: `${SPACING.base}px`,
              fontSize: `${s.sizePx}px`,
              fontWeight: s.weight,
              lineHeight: String(s.lineHeight),
              color: theme.colors.body,
              fontFamily: "GENZI, Ethiopic",
            },
            escapeHtml(input.subtitle.trim()),
          ),
        );
      }
      break;
    }
    case "short-story": {
      if (input.subtitle?.trim()) {
        const b = TYPOGRAPHY.body;
        contentChildren.push(
          div(
            {
              marginTop: `${SPACING.base}px`,
              fontSize: `${b.sizePx}px`,
              fontWeight: b.weight,
              lineHeight: String(b.lineHeight),
              color: theme.colors.body,
              fontFamily: "GENZI, Ethiopic",
            },
            escapeHtml(input.subtitle.trim()),
          ),
        );
      }
      break;
    }
  }

  contentChildren.push(footerBlock());

  return div(
    {
      display: "flex",
      flexDirection: "column",
      width: `${m.cardWidthPx}px`,
      height: `${m.cardHeightPx}px`,
      backgroundColor: bg,
      borderRadius: `${SHAPES.radiusCard}px`,
      padding: `${m.cardOuterMargin}px`,
      position: "relative",
      overflow: "hidden",
      fontFamily: "GENZI, Ethiopic",
      ...neonBorder(borderActive, accent),
    },
    gridLayer(accent, gridOpacity),
    glowLayer(accent, glowOpacity),
    div(
      {
        display: "flex",
        flexDirection: "column",
        flex: "1 1 100%",
        position: "relative",
        zIndex: 1,
      },
      ...contentChildren,
    ),
  );
}

function logoImage(): Block {
  // Inline the bundled logo as a data URI so satori never hits the network.
  const p = path.join(assetsDir(), "genzi-logo.png");
  try {
    const b64 = fs.readFileSync(p).toString("base64");
    return {
      type: "img",
      props: {
        src: `data:image/png;base64,${b64}`,
        width: LAYOUT_METRICS.logoSizePx,
        height: LAYOUT_METRICS.logoSizePx,
        style: { borderRadius: `${SHAPES.radiusPanel}px` },
      },
    } as unknown as Block;
  } catch {
    // Missing logo must not kill the card — fall back to the brand mark text.
    return div(
      {
        fontSize: `${TYPOGRAPHY.chip.sizePx}px`,
        fontWeight: TYPOGRAPHY.chip.weight,
        color: "#FFFFFF",
      },
      escapeHtml(BRAND.mark),
    );
  }
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/** Render HTML-ish element tree → SVG string via satori. Exposed for tests/gallery. */
export async function renderCardSvg(input: CardInput): Promise<string> {
  const fonts = await loadFonts();
  const el = buildCardElement(input);
  return satori(el as unknown as ReactNode, {
    width: LAYOUT_METRICS.cardWidthPx,
    height: LAYOUT_METRICS.cardHeightPx,
    fonts: fonts as never, // grammY-free satori FontOptions use a string|number Weight union
  });
}

/** SVG → PNG via resvg. */
export function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: LAYOUT_METRICS.cardWidthPx },
    font: { loadSystemFonts: false, defaultFontFamily: "GENZI" },
  });
  return Buffer.from(resvg.render().asPng());
}

/**
 * Main entry point. NEVER THROWS — returns null on any internal failure so
 * callers publish text-only (plan §2.3). Cached by slug across restarts.
 */
export async function renderCard(input: CardInput): Promise<CardPng | null> {
  try {
    if (!input.slug?.trim()) throw new Error("renderCard: slug required for caching");
    const cached = await readCache(input.slug);
    if (cached) {
      return { png: cached, widthPx: LAYOUT_METRICS.cardWidthPx, heightPx: LAYOUT_METRICS.cardHeightPx, fromCache: true };
    }
    const svg = await renderCardSvg(input);
    const png = svgToPng(svg);
    await writeCache(input.slug, png);
    return { png, widthPx: LAYOUT_METRICS.cardWidthPx, heightPx: LAYOUT_METRICS.cardHeightPx, fromCache: false };
  } catch (err) {
    console.warn(`[card-renderer] generation failed for "${input.slug}", publishing text-only:`, (err as Error).message);
    return null;
  }
}
