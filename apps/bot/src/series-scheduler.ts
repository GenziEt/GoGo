// Phase 4 (plan §Series): scheduled publisher for recurring formats.
//
// Reuses the exact sweeper pattern from event-reminders.ts: one interval scans,
// marks-before-sends (so a slow/failing send never double-publishes on the next
// sweep), and is idempotent via a sentAt-style flag. The difference is the fire
// rule: a series has a FIXED weekday and hour (SeriesSpec.fixedDayUtc in
// post-theme.ts — the scheduling contract), so instead of per-user reminder rows
// we keep ONE row per series episode keyed by (seriesKey, occurrence date).
//
// Episode sources: Posts already in the DB tagged with this seriesKey that are
// not yet published (visibility PUBLIC drafts queued by authors/admins). The
// scheduler publishes them on the series' fixed day — it never invents content.
// If nothing is queued for an episode, the slot is marked SKIPPED (logged) so
// the channel simply doesn't get a duplicate/off-day post; silence is better
// than filler, per the brand voice rules.
import type { Bot } from "grammy";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { SERIES, seriesFor, type Weekday } from "./post-theme.js";
import { publishToChannel } from "./telegram-publisher.js";
import { attachChannelButtons } from "./post-buttons.js";

/** Same cadence as the reminder sweep; cheap because most sweeps find nothing. */
export const SERIES_SWEEP_MS = 60_000;

/** Hour (UTC) series posts go out — mid-morning East Africa time (EAT = UTC+3). */
export const SERIES_FIRE_HOUR_UTC = 7;

const WEEKDAY_TO_JS: Record<Weekday, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

interface OccurrenceRow {
  seriesKey: string;
  /** ISO date (YYYY-MM-DD) of the fixed weekday this row represents. */
  occurrenceDate: string;
}

/** True when `now` is at/after the series fire moment for today's occurrence. */
function fireMomentReached(spec: { day: Weekday }, now: Date): boolean {
  if (now.getUTCDay() !== WEEKDAY_TO_JS[spec.day]) return false;
  return now.getUTCHours() >= SERIES_FIRE_HOUR_UTC;
}

/**
 * Core dispatch: find queued unpublished posts whose series fires today, publish
 * each once (idempotent via telegramMessageId), mark the occurrence done. Returns
 * the number of episodes published. Exported separately from the interval wiring
 * so tests / manual admin triggers can run one sweep without the bot loop.
 */
export async function dispatchDueSeriesEpisodes(bot: Bot): Promise<number> {
  const now = new Date();
  let published = 0;

  for (const key of Object.keys(SERIES)) {
    const spec = seriesFor(key);
    if (!spec || !fireMomentReached(spec, now)) continue;

    const occurrenceDate = now.toISOString().slice(0, 10);

    // Idempotency ledger: Setting row per (series, date). Created upsert-style so
    // concurrent sweeps can't both claim the slot — the updateMany guard below
    // only lets ONE sweep transition PENDING → DONE.
    const ledgerId = `series-episode:${key}:${occurrenceDate}`;
    const existing = await db.setting.findUnique({ where: { key: ledgerId } });
    if (existing && existing.value === "DONE") continue;

    if (!existing) {
      await db.setting.create({ data: { key: ledgerId, value: "PENDING" } });
    }

    // Claim the slot atomically: only the sweep that flips PENDING→DONE proceeds.
    const claim = await db.setting.updateMany({
      where: { key: ledgerId, value: "PENDING" },
      data: { value: "DONE" },
    });
    if (claim.count !== 1) continue; // another sweep already owns this occurrence

    // Queued episodes: posts tagged with this series, still unpublished.
    const queued = await db.post.findMany({
      where: {
        seriesKey: key,
        publishedAt: null,
        telegramMessageId: null,
        visibility: "PUBLIC",
      },
      orderBy: { createdAt: "asc" },
      take: 1, // one episode per slot keeps the fixed-day rhythm predictable
    });

    const post = queued[0];
    if (!post) {
      // Nothing authored for this slot — skip quietly (never fabricate content).
      logger.info("series slot empty, skipped", { seriesKey: key, occurrenceDate });
      continue;
    }

    try {
      const result = await publishToChannel(bot, {
        title: post.title,
        body: post.body,
        tags: safeParseTags(post.tagsJson),
        author: post.authorName,
        category: post.category,
        // Phase 2 card pipeline: slug enables generation/caching; series episodes
        // are structural rhythm posts, so the branded card is always on.
        cardSlug: post.slug,
        preferCard: true,
        ...(post.mediaType ? { mediaType: post.mediaType } : {}),
        ...(post.mediaFileId ? { mediaFileId: post.mediaFileId } : {}),
        ...(post.location ? { location: post.location } : {}),
        ...(post.linkUrl ? { linkUrl: post.linkUrl } : {}),
        ...(post.factsJson ? { factValues: safeParseFacts(post.factsJson) } : {}),
        seriesKey: key,
        ...(post.captionAbove !== null && post.captionAbove !== undefined ? { captionAbove: post.captionAbove } : {}),
        readingMinutes: post.readingMinutes,
      });

      // Same tracked-button rows as every other channel path (Read More _c suffix).
      await attachChannelButtons(bot, result.chatId, result.messageId, {
        slug: post.slug,
        messageId: result.messageId,
        chatId: result.chatId,
        linkUrl: post.linkUrl,
        linkPlatform: post.linkPlatform,
        buttonSource: "channel",
      });

      await db.post.update({
        where: { id: post.id },
        data: { publishedAt: now, telegramChatId: result.chatId, telegramMessageId: result.messageId },
      });
      published++;
      logger.info("series episode published", { seriesKey: key, slug: post.slug, occurrenceDate });
    } catch (error) {
      // Slot stays claimed (value already DONE) so a broken post can't spam-retry
      // every 60s; the failure is logged for an operator to fix and re-run.
      logger.error("series episode publish failed", { seriesKey: key, slug: post.slug, error: String(error) });
    }
  }
  return published;
}

function safeParseTags(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

function safeParseFacts(json: string): Record<string, string> {
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
    return out;
  } catch { return {}; }
}

/** Interval wiring, mirroring how event-reminders is started in index.ts. */
export function startSeriesScheduler(bot: Bot): NodeJS.Timeout {
  const timer = setInterval(() => {
    void dispatchDueSeriesEpisodes(bot).catch((error) => logger.error("series sweep crashed", { error: String(error) }));
  }, SERIES_SWEEP_MS);
  timer.unref?.();
  return timer;
}

/** Test helper: shape of the ledger row for a given occurrence. */
export function occurrenceLedgerId(row: OccurrenceRow): string {
  return `series-episode:${row.seriesKey}:${row.occurrenceDate}`;
}
