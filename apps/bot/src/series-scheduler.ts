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

      // Phase 4 (plan §Poll follow-ups): "Which one?" poll attached to the episode.
      // Poll content is authored alongside the episode (pollQuestion/pollOptionsJson
      // on Post) — the scheduler never invents options, matching the no-filler rule.
      // Best-effort: a failed poll send never un-publishes the episode.
      try {
        const pollOptions = parsePollOptions(post.pollOptionsJson);
        if (post.pollQuestion && pollOptions.length >= 2) {
          await bot.api.sendPoll(result.chatId, post.pollQuestion, pollOptions, {
            reply_parameters: { message_id: result.messageId },
          });
        }
      } catch (error) {
        logger.warn("series poll follow-up failed (non-fatal)", { seriesKey: key, slug: post.slug, error: String(error) });
      }

      // Phase 4 (plan §Daily quiz): reuse the existing Quiz model — pick the newest
      // active quiz whose category matches the episode's category (fallback: any
      // active quiz), render its first question as a Telegram QUIZ-mode poll replied
      // under the episode. No quiz rows exist → skip silently. Best-effort again.
      try {
        const quizPoll = await buildDailyQuizPoll(post.category);
        if (quizPoll) {
          await bot.api.sendPoll(result.chatId, quizPoll.question, quizPoll.options, {
            type: "quiz",
            correct_option_id: quizPoll.correctIndex,
            is_anonymous: true,
            reply_parameters: { message_id: result.messageId },
          });
        }
      } catch (error) {
        logger.warn("daily quiz poll failed (non-fatal)", { seriesKey: key, slug: post.slug, error: String(error) });
      }
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

/** Telegram allows max 10 poll options; trim strings, drop empties, cap at 10. */
function parsePollOptions(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x).trim().slice(0, 100)).filter(Boolean).slice(0, 10);
  } catch { return []; }
}

interface QuizPollShape { question: string; options: string[]; correctIndex: number }

/**
 * Daily quiz follow-up (plan §Poll or quiz follow-ups): reuses the existing Quiz
 * model rather than a new table. Newest active quiz matching the episode category
 * wins; falls back to any newest active quiz. Returns null when no usable quiz
 * exists — the scheduler then sends nothing (never fabricates questions).
 * Telegram quiz polls need 2–10 options and exactly one correct answer.
 */
export async function buildDailyQuizPoll(category: string): Promise<QuizPollShape | null> {
  const quizzes = await db.quiz.findMany({
    where: { active: true },
    orderBy: { createdAt: "desc" },
    take: 12,
    include: { questions: { orderBy: { position: "asc" }, take: 1, include: { options: { orderBy: { position: "asc" } } } } },
  });
  const pick = quizzes.find((q) => q.category === category) ?? quizzes[0];
  const question = pick?.questions[0];
  if (!question) return null;
  const options = question.options.map((o) => o.text.trim().slice(0, 100)).filter(Boolean).slice(0, 10);
  if (options.length < 2) return null;
  // Recompute the correct index AFTER trimming/capping so it can't dangle past the end.
  const originalIndexes = question.options
    .map((o, i) => ({ text: o.text.trim().slice(0, 100), isCorrect: o.isCorrect, i }))
    .filter((o) => o.text)
    .slice(0, 10);
  const correctPos = originalIndexes.findIndex((o) => o.isCorrect);
  if (correctPos < 0) return null; // Telegram quiz mode REQUIRES a correct answer; skip if none.
  return { question: question.question.slice(0, 300), options, correctIndex: correctPos };
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
