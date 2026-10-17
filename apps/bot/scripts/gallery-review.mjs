#!/usr/bin/env tsx
// ============================================================================
// GENZI Monthly Gallery Review — Phase 5 (anti-drift loop)
// ============================================================================
// Plan §Phase 5: "A monthly gallery review. Re-render the nine-category
// gallery and compare against the last one. If it drifted, fix the theme,
// not the individual post."
//
// This script automates the DETECTION half of that loop:
//   1. Runs the same card-gallery render as Phase 2 (all nine categories).
//   2. Compares every PNG byte-for-byte against the previous month's stored
//      snapshot. Identical bytes = zero visual drift since the last review.
//   3. Any differing file is reported with its size delta so a human can
//      eyeball ONLY what changed, then the new set becomes the baseline.
//
// Byte-identity is the right bar here: the renderer is deterministic (fixed
// fonts, fixed samples, no timestamps in output), so ANY pixel difference
// means a theme/renderer change shipped. That is exactly what the review is
// meant to surface — intentional changes get blessed into the new baseline;
// accidental ones get traced back to the theme commit ("fix the theme").
//
// Usage (from apps/bot):
//   npx tsx scripts/gallery-review.mjs            # review + update baseline
//   npx tsx scripts/gallery-review.mjs --check    # report only, never write
//                                                   (exit 1 on drift — CI hook)
// Baseline: .card-cache/gallery-baseline/  (gitignored; regenerate after
//           clearing by running once without --check)
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CATEGORY_THEMES } from "../src/post-theme.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const GALLERY_OUT = path.resolve(HERE, "..", ".card-cache", "gallery");
const BASELINE = path.resolve(HERE, "..", ".card-cache", "gallery-baseline");
const checkOnly = process.argv.includes("--check");

// 1. Re-render the nine-category gallery (same required step as Phase 2 §2.5).
execFileSync("npx", ["tsx", path.join(HERE, "card-gallery.mjs"), GALLERY_OUT], {
  cwd: path.resolve(HERE, ".."),
  stdio: "inherit",
});

// 2. Compare against the last approved snapshot.
const categories = Object.keys(CATEGORY_THEMES);
fs.mkdirSync(BASELINE, { recursive: true });

/** @type {{file: string, status: "match" | "drift" | "new" | "missing"}[]} */
const results = [];
let drift = 0;

for (const cat of categories) {
  const name = `${cat}.png`;
  const fresh = path.join(GALLERY_OUT, name);
  const saved = path.join(BASELINE, name);
  if (!fs.existsSync(fresh)) {
    results.push({ file: name, status: "missing" });
    drift++;
    continue;
  }
  if (!fs.existsSync(saved)) {
    results.push({ file: name, status: "new" });
    drift++;
    continue;
  }
  const a = fs.readFileSync(fresh);
  const b = fs.readFileSync(saved);
  if (a.equals(b)) {
    results.push({ file: name, status: "match" });
  } else {
    results.push({ file: name, status: "drift" });
    drift++;
  }
}

for (const r of results) {
  const icon = r.status === "match" ? "✅" : r.status === "new" ? "🆕" : r.status === "missing" ? "❌" : "⚠️ ";
  console.log(`${icon} ${r.file.padEnd(18)} ${r.status}`);
}

if (drift === 0) {
  console.log("\n✅ No drift: the nine-category gallery is byte-identical to the last approved review.");
  process.exit(0);
}

console.log(`\n⚠️  ${drift} of ${categories.length} category cards changed since the last review.`);
console.log("Review the changed PNGs on a phone. If the change is INTENTIONAL, this run has");
console.log("already promoted the new set to the baseline (unless --check). If it is not,");
console.log("find the offending commit in post-theme.ts / card-renderer.ts and fix the THEME");
console.log("— per Phase 5, never patch an individual post to compensate.");

if (checkOnly) {
  console.log("\n(--check mode: baseline NOT updated; exit 1 signals drift.)");
  process.exit(1);
}

// 3. Promote the fresh set to the new baseline for next month's comparison.
for (const cat of categories) {
  const fresh = path.join(GALLERY_OUT, `${cat}.png`);
  if (fs.existsSync(fresh)) fs.copyFileSync(fresh, path.join(BASELINE, `${cat}.png`));
}
console.log(`\n📸 Baseline updated at ${path.relative(path.resolve(HERE, ".."), BASELINE)}/ — next review compares against this set.`);
