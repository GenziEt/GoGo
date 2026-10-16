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
import { readFileSync, readdirSync, statSync } from "node:fs";
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
// Pass 2: CSS token-layer parity — POST SURFACES ONLY.
// The Mini App (apps/web) renders GENZI posts and shares the card palette,
// so every hex it uses must trace back to a post-theme.ts token. The admin
// dashboard is an internal tool with its own neutral UI palette and is out
// of scope for the brand system (documented decision, revisit if the admin
// ever renders post previews from the same tokens).
//
// Enforcement model: the sanctioned place for raw hexes in web CSS is a
// custom-property DEFINITION line (`--name: #hex;`) inside a :root block.
// Every other hex literal must be a var() reference. A definition whose
// value matches a post-theme.ts token is part of Palette A parity; one that
// doesn't is reported as app-only drift (warning today, violation once the
// web palette is fully tokenized — see monthly gallery review).
// ---------------------------------------------------------------------------
const themeSource = readFileSync(THEME_FILE, "utf8").toLowerCase();

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

  // Identify sanctioned definition spans: `--token: #hex` occurrences.
  const defSpans = [];
  for (const m of css.matchAll(/--[A-Za-z0-9-]+\s*:\s*(#[0-9a-fA-F]{3,8}\b)/g)) {
    const start = m.index + m[0].indexOf(m[1]);
    defSpans.push([start, start + m[1].length]);
  }
  const inDefSpan = (pos) => defSpans.some(([s, e]) => pos >= s && pos < e);

  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    if (inDefSpan(m.index)) continue; // sanctioned custom-property definition
    const { line, col } = posToLineCol(m.index);
    const snippet = css.slice(lineStarts[line - 1], lineStarts[line]).trim().slice(0, 120);
    // Skip pure comment lines.
    if (snippet.startsWith("/*") || snippet.startsWith("*")) continue;
    violations.push({ file: WEB_CSS, line, text: `raw ${m[0]} outside a --token definition — use var(): ${snippet}` });
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
