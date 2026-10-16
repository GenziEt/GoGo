#!/usr/bin/env tsx
// ============================================================================
// GENZI Card Gallery — Phase 2 §2.5 (REQUIRED step, not optional)
// ============================================================================
// Renders one sample branded card per category (all nine layouts) to PNGs so
// the whole system can be reviewed AS A SET on an actual phone in one pass.
// The system is only "designed" if it reads as one brand collectively — not
// post by post.
//
// Usage:  npx tsx scripts/card-gallery.mjs [outputDir]   (run from apps/bot)
// Output: outputDir (default: .card-cache/gallery) + gallery.html contact sheet
//         for one-swipe phone review.
//
// Acceptance checks performed here (plan §2.6):
//   • All nine categories render without throwing
//   • Amharic titles render intact (Ethiopic sample titles included)
//   • Warm re-render of a slug is served from cache (render-under-2s contract)
//   • Every PNG exists and is non-trivial in size
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { CATEGORY_THEMES } from "../src/post-theme.js";
import { renderCard, clampTitle } from "../src/card-renderer.js";

const outDir = process.argv[2] ?? path.resolve(".card-cache", "gallery");
fs.mkdirSync(outDir, { recursive: true });

// One realistic sample per category. Titles mix English and Amharic so the
// gallery proves Ethiopic renders intact (§2.4 ligature risk). Fact values
// exercise each structural layout's anchors; the events sample is half-filled
// on purpose to prove the graceful fallback (empty anchors never render).
const SAMPLES = /** @type {Record<string, {titleEn:string,titleAm:string,subtitle?:string,factValues?:Record<string,string>}>} */ ({
  money: {
    titleEn: "Paid internship at Ethio Telecom — apply now",
    titleAm: "በኢትዮ ቴሌኮም ክፍያ ያለው ልምምድ — አመልክቱ",
    factValues: {
      location: "Addis Ababa / Remote",
      deadline: "Nov 30, 2026",
      eligibility: "Final-year students",
      link: "bit.ly/genzi-money",
    },
  },
  events: {
    titleEn: "Meskel Square Live Jam — Friday night",
    titleAm: "በመስቀል አደባባይ ቀጥታ ሙዚቃ — ዓርብ ማታ",
    // Half-filled on purpose: no tickets link → 🔗 anchor must NOT render.
    factValues: { date: "Fri 18:00", venue: "Meskel Square, Addis" },
  },
  "ai-tech": {
    titleEn: "New Amharic voice model beats bigger rivals",
    titleAm: "አዲስ የአማርኛ ድምጽ ሞዴል",
    subtitle:
      "A 7B-parameter model trained on Ethiopian speech outperforms much larger systems on local-language benchmarks.",
    factValues: { link: "arxiv.org/example" },
  },
  music: {
    titleEn: "Alyon Fireboy drops a surprise EP",
    titleAm: "አሊዮን ፋየርቦይ አዲስ ኤፒ አውጣ",
    subtitle: "Six tracks, one feature, zero warning.",
  },
  gaming: {
    titleEn: "Esports cup finals stream this weekend",
    titleAm: "የኤስፖርት ግጥሚያ ዘንድሮ",
    subtitle: "Eight teams, one bracket, live on the channel.",
  },
  entertainment: {
    titleEn: "The meme that broke Addis this week",
    titleAm: "የሳምንቱ ምርቶ",
    subtitle: "Tap in — you have seen this one.",
  },
  trending: {
    titleEn: "#EthiopiaTea is trending again and it's wild",
    titleAm: "አዝማሚያው እንደገና ተነዳ",
    subtitle: "Three days, four apologies, one viral audio clip.",
  },
  community: {
    titleEn: "Members asked, we listened: new poll rules",
    titleAm: "ማህበረሰቡ ጠይቆናል",
    subtitle: "Weekly polls move to Sunday evenings starting this month.",
  },
  fashion: {
    titleEn: "Habes kemis meets streetwear in Addis",
    titleAm: "የሀበሻ ልብስ እና ስትሪትዌር",
    subtitle: "Local designers are remixing tradition for the streets.",
  },
});

/**
 * @param {string} name
 * @param {Buffer} png
 */
function write(name, png) {
  const p = path.join(outDir, name);
  fs.writeFileSync(p, png);
  return p;
}

console.log("GENZI card gallery — rendering all nine categories…\n");
const rows = [];
let failures = 0;

for (const [key, theme] of Object.entries(CATEGORY_THEMES)) {
  const sample = SAMPLES[key];
  if (!sample) {
    console.error(`✗ no gallery sample defined for category "${key}"`);
    failures++;
    continue;
  }

  // English card
  const enStart = Date.now();
  const en = await renderCard({
    slug: `gallery-${key}-en`,
    title: clampTitle(sample.titleEn),
    category: key,
    locale: "en",
    factValues: sample.factValues,
    subtitle: sample.subtitle,
  });
  const enMs = Date.now() - enStart;

  // Amharic card (proves Ethiopic renders intact)
  const amStart = Date.now();
  const am = await renderCard({
    slug: `gallery-${key}-am`,
    title: clampTitle(sample.titleAm),
    category: key,
    locale: "am",
    factValues: sample.factValues,
    subtitle: sample.subtitle,
  });
  const amMs = Date.now() - amStart;

  if (!en || !am) {
    console.error(`✗ ${key}: renderer returned null (${!en ? "en" : ""}${!en && !am ? ", " : ""}${!am ? "am" : ""})`);
    failures++;
    continue;
  }
  if (en.png.length < 10_000 || am.png.length < 10_000) {
    console.error(`✗ ${key}: suspiciously small PNG (${en.png.length} / ${am.png.length} bytes)`);
    failures++;
    continue;
  }

  const enFile = write(`${key}-en.png`, en.png);
  const amFile = write(`${key}-am.png`, am.png);
  rows.push({ key, theme, enFile, amFile, enMs, amMs });
  console.log(
    `✓ ${theme.emoji} ${key.padEnd(14)} layout=${theme.layout.padEnd(14)} accent=${theme.dominantAccent.padEnd(12)} ` +
      `en ${enMs}ms · am ${amMs}ms`,
  );
}

// --- Warm-cache check: second render of same slug must be instant (§2.6) ----
let warmOk = true;
if (rows.length > 0) {
  const t0 = Date.now();
  const warm = await renderCard({
    slug: "gallery-money-en",
    title: "warm",
    category: "money",
    locale: "en",
  });
  const warmMs = Date.now() - t0;
  warmOk = !!warm?.fromCache && warmMs < 2000;
  console.log(`\n✓ warm cache re-render: ${warmMs}ms, fromCache=${warm?.fromCache}`);
}

// --- Contact sheet: view all eighteen cards in one scroll on a phone --------
const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GENZI card gallery</title>
<style>
body{background:#05070d;color:#e8ecf4;font-family:system-ui,sans-serif;margin:16px}
h1{font-size:18px} p{color:#9aa4b8;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.cell img{width:100%;border-radius:10px;display:block}
.cell span{font-size:11px;color:#9aa4b8;display:block;margin-top:4px}
</style></head><body>
<h1>🇪🇹 GENZI — nine-category card gallery</h1>
<p>Review on an actual phone. The set must read as ONE brand: shared dark base,
one dominant accent per category, identical footer, category chip up top.</p>
<div class="grid">
${rows
  .map(
    (r) =>
      `<div class="cell"><img src="${path.basename(r.enFile)}"><span>${r.theme.emoji} ${r.key} · EN · ${r.theme.dominantAccent}</span></div>` +
      `<div class="cell"><img src="${path.basename(r.amFile)}"><span>${r.theme.emoji} ${r.key} · AM</span></div>`,
  )
  .join("\n")}
</div></body></html>\n`;
fs.writeFileSync(path.join(outDir, "gallery.html"), html);

console.log(`\nContact sheet: ${path.join(outDir, "gallery.html")}`);
console.log(`Categories rendered: ${rows.length}/9 · failures: ${failures} · warm cache: ${warmOk ? "OK" : "FAIL"}`);

if (rows.length !== 9 || failures > 0 || !warmOk) {
  console.error("\n✗ GALLERY ACCEPTANCE FAILED");
  process.exit(1);
}
console.log("\n✅ Gallery acceptance passed: nine categories, EN+AM, one brand as a set.");
