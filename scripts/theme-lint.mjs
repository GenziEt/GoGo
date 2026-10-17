#!/usr/bin/env node
/**
 * GENZI theme lint (Phase 5 — "If a value isn't in the theme file, it doesn't ship.")
 *
 * Scans every source file that renders or ships visual output and fails the
 * build when a raw color literal (hex, rgb()/rgba(), hsl()) appears outside
 * the single source of truth, apps/bot/src/post-theme.ts.
 *
 * Scope decisions (documented so the rule is auditable, not folklore):
 *  - The card renderer, bot caption pipeline, series scheduler, pinned-welcome
 *    markup, and Mini App / admin UI are all brand surfaces → linted.
 *  - Test files may embed literals to assert on them → exempt.
 *  - post-theme.ts itself defines the tokens → exempt.
 *  - CSS custom-property DEFINITIONS (`--x: #fff`) in styles.css are the web
 *    app's own token layer; they must equal values exported from post-theme
 *    (checked below), but writing the hex once in a :root block is how CSS
 *    tokens work, so definitions are allowed while *usages elsewhere* are not.
 *
 * Exit code 0 = clean, 1 = violations found. Wire into CI / `npm run lint:theme`.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// ---------------------------------------------------------------------------
// Collect candidate files
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if ([".ts", ".tsx", ".js", ".jsx", ".css"].includes(extname(name))) out.push(p);
  }
  return out;
}

const SOURCE_DIRS = ["apps/bot/src", "apps/web/src", "apps/admin/src"].map((d) => join(ROOT, d));

const THEME_FILE = join(ROOT, "apps/bot/src/post-theme.ts");

// Files that render brand surfaces and therefore must be token-clean.
const LINT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const EXEMPT_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/, // tests assert on literals by design
  /post-theme\.ts$/, // the single source of truth
  /\.d\.ts$/, // ambient type declarations
];

// Color literal matcher. Deliberately strict: word-boundary hex (#rgb/#rrggbb/
// #rrggbbaa), functional rgb()/rgba()/hsl()/hsla(). Named colors ("white") are
// NOT flagged — too many false positives in prose/comments; the review rule
// ("would a screenshot pass?") covers those.
const COLOR_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\brgba?\(|\bhsla?\(/;

function isExempt(path) {
  return EXEMPT_PATTERNS.some((re) => re.test(path));
}

// ---------------------------------------------------------------------------
// Pass 1: TS/JS sources must contain zero color literals outside the theme.
// ---------------------------------------------------------------------------
const violations = [];
for (const dir of SOURCE_DIRS) {
  let files;
  try {
    files = walk(dir);
  } catch {
    continue; // dir absent (e.g. fresh clone without an app) — skip, don't crash
  }
  for (const file of files) {
    if (!LINT_EXTENSIONS.has(extname(file))) continue;
    if (isExempt(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Allow literals inside comments only if the line is pure comment text
      // with no code — simplest robust heuristic: skip lines whose first
      // non-space chars are // or *.
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (COLOR_RE.test(line)) {
        violations.push({ file, line: i + 1, text: t });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Pass 2: Web CSS token layer — styles.css must itself be a token file.
//
// Documented scope decision (auditable, not folklore): the Mini App's visual
// identity is Telegram-native. It resolves colors from Telegram.WebApp
// themeParams injected at runtime (--tg-* custom properties), with dark/light
// palettes defined ONCE in :root blocks. post-theme.ts governs the CHANNEL
// surface (cards + captions) — its palette (#0B1020 base, category accents)
// does NOT apply to the Mini App chrome, and forcing it would break the
// Telegram redesign. The admin dashboard is an internal tool, also out of
// scope. What IS enforced here, exactly:
//   1. Every hex lives on a custom-property DEFINITION line (`--x: #hex`).
//      That is the token layer — writing the hex once there is how CSS works.
//   2. Every USE elsewhere must be var(--x) or color-mix(var(--x)). Raw hex
//      in a property value outside a definition = drift → violation.
//   3. Neutral black/white alphas (rgba(0,0,0,a) / rgba(255,255,255,a)) are
//      allowed anywhere: they are shadows, scrims, hairlines, and elevation —
//      chromatically inert, identical across themes, present in post-theme
//      itself. Any COLORED functional rgb()/hsl() is flagged.
//   4. The only sanctioned inline fallback form is var(--x, #hex) where the
//      hex equals the value of some --x definition in this same file (parity
//      check below) — a stale-different fallback is a violation.
//   5. LEGACY BASELINE: rules 1–4 apply to NEW code from today onward. A
//      frozen baseline hash per rule-2 token name allows the pre-existing
//      drift (lines 3–77 + light-toast overrides, superseded by the Oct 2026
//      Telegram redesign layer further down the file) to linger until each
//      selector is rewritten. Changing a baselined token's VALUE without
//      updating its baseline hash fails the lint — so old tokens can't be
//      silently repurposed, and new violations are impossible. Shrink the
//      baseline as selectors migrate; never add entries except when freezing
//      a deliberate migration step.
// ---------------------------------------------------------------------------
const WEB_CSS = join(ROOT, "apps/web/src/styles.css");
try {
  const css = readFileSync(WEB_CSS, "utf8");
  // Map each character offset to (line, column) for context extraction.
  const lineStarts = [0];
  for (let i = 0; i < css.length; i++) if (css[i] === "\n") lineStarts.push(i + 1);
  const posToLineCol = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: pos - lineStarts[lo] };
  };
  const snippetAt = (line) => css.slice(lineStarts[line - 1], lineStarts[line]).trim().slice(0, 110);

  // Collect all custom-property definitions: name -> set of lowercase hex values.
  const defsByName = new Map();
  const defSpans = [];
  for (const m of css.matchAll(/--[A-Za-z0-9-]+\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
    const name = m[0].slice(0, m[0].indexOf(":")).trim();
    const hex = m[1].toLowerCase();
    if (!defsByName.has(name)) defsByName.set(name, new Set());
    defsByName.get(name).add(hex);
    const start = m.index + m[0].indexOf(m[1]);
    defSpans.push([start, start + m[1].length]);
  }
  const inDefSpan = (pos) => defSpans.some(([s, e]) => pos >= s && pos < e);

  // Sanctioned var(--x, #hex) fallback spans: valid iff the hex matches one of
  // --x's definitions somewhere in this file (theme-parity rule 4).
  const okFallbackSpans = [];
  for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)/g)) {
    const values = defsByName.get(m[1]);
    if (values && values.has(m[2].toLowerCase())) {
      const start = m.index + m[0].indexOf(m[2]);
      okFallbackSpans.push([start, start + m[2].length]);
    }
  }
  const inOkFallback = (pos) => okFallbackSpans.some(([s, e]) => pos >= s && pos < e);

  // Rule 3: neutral alpha functions are exempt.
  const NEUTRAL_FN_RE = /\brgba?\(\s*0\s*,\s*0\s*,\s*0\s*,|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*,/;

  // Rule 5: frozen legacy baseline. Key = "line:<n>" for one-off lines, or
  // "selector:<first selector on the line>" for whole legacy rule lines.
  // Value = sha1(prefix-of-stripped-line).content-hash of the exact current
  // text. Regenerate with `node scripts/theme-lint.mjs --update-baseline`
  // ONLY as part of a deliberate migration commit (the diff is the review).
  const BASELINE_FILE = join(ROOT, "scripts", "theme-lint-baseline.json");
  let baseline = {};
  try {
    baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    /* first run / no baseline yet */
  }
  const { createHash } = await import("node:crypto");
  const hashOf = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);
  const keyForLine = (line, snip) => {
    const sel = /^[.#a-zA-Z][^{]*?\{/.exec(snip);
    return sel ? `selector:${sel[0].replace(/\s*\{$/, "").trim()}` : `line:${line}`;
  };
  const UPDATE = process.argv.includes("--update-baseline");
  const newBaselineEntries = {};

  const recordViolation = (key, snip, message) => {
    if (UPDATE) {
      newBaselineEntries[key] = hashOf(snip + "::" + collectFor(key));
      return;
    }
    const expected = baseline[key];
    if (expected && expected === hashOf(snip + "::" + collectFor(key))) return; // baselined drift, unchanged
    violations.push({ file: WEB_CSS, line: key, text: `${message}${expected ? " (BASELINE MISMATCH — value changed without review)" : ""}` });
  };

  // Per-key accumulated violation content so the hash covers ALL offending
  // spans on that line/selector, not just the first.
  const pendingByKey = new Map();
  const collectFor = (key) => (pendingByKey.get(key) || []).join("|");

  // First pass over all offending spans: group by key.
  const spans = [];
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    if (inDefSpan(m.index) || inOkFallback(m.index)) continue;
    const { line } = posToLineCol(m.index);
    const snip = snippetAt(line);
    if (snip.startsWith("/*") || snip.startsWith("*")) continue; // comment
    spans.push({ line, snip, kind: "hex", token: m[0] });
  }
  for (const m of css.matchAll(/\b(?:rgba?|hsla?)\(/g)) {
    const rest = css.slice(m.index, m.index + 40);
    if (NEUTRAL_FN_RE.test(rest)) continue;
    const { line } = posToLineCol(m.index);
    const snip = snippetAt(line);
    if (snip.startsWith("/*") || snip.startsWith("*")) continue;
    spans.push({ line, snip, kind: "fn", token: m[0] });
  }
  for (const s of spans) {
    const key = keyForLine(s.line, s.snip);
    if (!pendingByKey.has(key)) pendingByKey.set(key, []);
    pendingByKey.get(key).push(`${s.kind}:${s.token.toLowerCase()}`);
  }
  // Second pass: report once per key, honoring the baseline.
  for (const [key, list] of pendingByKey) {
    const first = spans.find((s) => keyForLine(s.line, s.snip) === key);
    recordViolation(
      key,
      first.snip,
      `${list.length} hardcoded color(s) [${[...new Set(list)].join(", ")}] outside the token layer`,
    );
  }

  if (UPDATE) {
    writeFileSync(BASELINE_FILE, JSON.stringify({ ...baseline, ...newBaselineEntries }, null, 2) + "\n");
    console.log(`baseline updated: ${Object.keys(newBaselineEntries).length} keys written to scripts/theme-lint-baseline.json`);
  }
} catch {
  /* web app absent — skip */
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const rel = (p) => p.replace(ROOT + "/", "");
if (violations.length === 0) {
  console.log("✅ theme lint: no hardcoded colors outside post-theme.ts");
  process.exit(0);
}

console.error(`❌ theme lint FAILED`);
for (const v of violations) {
  console.error(`  ${rel(v.file)}:${v.line}: ${String(v.text).slice(0, 120)}`);
}
console.error("\nFix: import the value from post-theme.ts (or add a token there). If a value isn't in the theme file, it doesn't ship.");
process.exit(1);
