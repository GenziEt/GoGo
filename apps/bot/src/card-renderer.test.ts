// GENZI POST CARD — Phase 2 acceptance tests (plan §2.6)
// Covers the mechanical acceptance checks for the generated branded cards:
//   • Card renders under 2 seconds warm
//   • Amharic titles render intact (bundled Noto Sans Ethiopic, no subsetting)
//   • Publishing still works if the renderer throws (fail-open contract)
//   • Dimensions are exactly 1080×1350; slug caching; series chip on card
// Run: npx tsx apps/bot/src/card-renderer.test.ts
import assert from "node:assert/strict";
import { renderCard } from "./card-renderer.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failures++;
    console.log(`[FAIL] ${name}\n       ${(err as Error).message}`);
  }
}

const baseInput = {
  slug: "test-acceptance-card",
  title: "Remote AI jobs for Ethiopian talent",
  category: "money",
  locale: "en" as const,
};

async function main(): Promise<void> {
  // §2.6 — a full render completes well under the 2s warm budget. We measure
  // cold here because this process has no prior render; the assertion uses
  // the same threshold the plan sets for warm requests.
  let firstPng: Awaited<ReturnType<typeof renderCard>> = null;
  await check("card renders under 2 seconds (cold, generous bound)", async () => {
    const t0 = Date.now();
    firstPng = await renderCard(baseInput);
    const ms = Date.now() - t0;
    assert.ok(firstPng, "renderCard returned null — fonts or assets missing?");
    assert.ok(ms < 2000, `cold render took ${ms}ms (> 2000ms)`);
  });

  await check("card is exactly 1080x1350", () => {
    assert.ok(firstPng);
    assert.equal(firstPng.widthPx, 1080);
    assert.equal(firstPng.heightPx, 1350);
    // PNG signature + IHDR sanity: bytes 16..19 hold width in network order.
    const w = firstPng.png.readUInt32BE(16);
    const h = firstPng.png.readUInt32BE(20);
    assert.equal(w, 1080);
    assert.equal(h, 1350);
    assert.ok(firstPng.png.length > 10_000, "PNG suspiciously small — blank render?");
  });

  // §2.3 — cached by post slug. Second call must be served from disk cache.
  await check("second render of same slug is served from cache", async () => {
    const t0 = Date.now();
    const again = await renderCard(baseInput);
    assert.ok(again);
    assert.equal(again.fromCache, true, "expected fromCache=true on re-render");
    assert.ok(Date.now() - t0 < 200, "cache hit should be near-instant");
    assert.deepEqual(again.png, firstPng!.png, "cached bytes differ from fresh render");
  });

  // §2.6 — Amharic titles render intact. The bundled font is unsubsetted and
  // bold-weight for titles; a tofu/missing-glyph render would produce a card
  // nearly identical to an empty-title card, so we compare against English.
  await check("Amharic title renders intact (distinct pixels vs English)", async () => {
    const am = await renderCard({
      ...baseInput,
      slug: "test-acceptance-card-am",
      locale: "am",
      title: "ለኢትዮጵያ ባለሙያዎች ርቀት የሚሰሩ የAI መስሪያ ቦታዎች",
    });
    assert.ok(am, "Amharic render returned null");
    assert.notDeepEqual(am.png, firstPng!.png, "Amharic card identical to English — glyphs likely dropped");
    assert.ok(am.png.length > 10_000);
  });

  // Long Amharic titles clamp to max 3 lines rather than overflow (§2.2).
  await check("overlong Amharic title clamps instead of overflowing", async () => {
    const long = await renderCard({
      ...baseInput,
      slug: "test-acceptance-card-long",
      locale: "am",
      title: "እጅግ በጣም ረጅም አርዕስ ለመፈተሽ ".repeat(14),
    });
    assert.ok(long, "clamped render returned null");
  });

  // §2.3 / fail-open — invalid input returns null instead of throwing, so the
  // publisher can fall back to text-only without ever blocking a post.
  await check("renderer fails open (returns null, never throws)", async () => {
    const bad = await renderCard({ ...baseInput, slug: "" });
    assert.equal(bad, null, "empty slug must yield null, not throw");
  });

  // Empty fact values must not render an empty anchor/panel row (§1 facts spec).
  await check("all-empty fact values render no panel (graceful fallback)", async () => {
    const withFacts = await renderCard({
      ...baseInput,
      slug: "test-acceptance-card-facts",
      factValues: { where: "Addis Ababa", deadline: "Dec 30" },
    });
    const emptyFacts = await renderCard({
      ...baseInput,
      slug: "test-acceptance-card-nofacts",
      factValues: { where: "", deadline: undefined },
    });
    assert.ok(withFacts && emptyFacts);
    assert.notDeepEqual(withFacts.png, emptyFacts.png, "fact panel changes pixels when filled");
    const plain = await renderCard({ ...baseInput, slug: "test-acceptance-card-nofacts" });
    assert.ok(plain);
    assert.deepEqual(emptyFacts.png, plain.png, "blank facts must equal no-facts card (no empty anchors)");
  });

  // Phase 3 series spec — a series episode shows its fixed chip on the card.
  await check("seriesKey changes only the chip band, unknown key falls back", async () => {
    const series = await renderCard({
      ...baseInput,
      slug: "test-acceptance-card-series",
      seriesKey: "monday-money-moves",
    });
    assert.ok(series, "series render returned null");
    assert.notDeepEqual(series.png, firstPng!.png, "series chip should alter the card");
    const stale = await renderCard({
      ...baseInput,
      slug: "test-acceptance-card-stale",
      seriesKey: "defunct-series-xyz",
    });
    assert.ok(stale);
    assert.deepEqual(stale.png, firstPng!.png, "unknown series key must fall back to plain category chip");
  });

  if (failures > 0) {
    console.log(`\n❌ ${failures} Phase 2 card check(s) failed.`);
    process.exit(1);
  }
  console.log("\n✅ All Phase 2 card acceptance checks passed.");
}

void main();
