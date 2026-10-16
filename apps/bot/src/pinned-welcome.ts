// Phase 4 (plan §Pinned post): one pinned welcome post on the channel with the three
// main buttons, kept up to date by the bot.
//
// Design contract:
// - The module owns EXACTLY ONE channel message (the pinned welcome). It never touches
//   regular posts. Ownership is recorded in a Setting row keyed by the channel id, so a
//   restart — or even a manual deletion/unpin by an admin — doesn't create duplicates.
// - Content is derived at refresh time from live data: the three "main buttons" mirror
//   the Mini App's primary destinations (App open, Opportunities, Trending), and the
//   body lists the registered series with their fixed days (Phase 3 series spec), so
//   the post stays truthful as the lineup changes.
// - Strictly best-effort (§2.3 publishing-never-blocked contract extended here): every
//   failure path logs a warning and returns; nothing thrown from this module can crash
//   the bot or block any publish. Telegram errors like chat_not_found / not_enough_rights
//   are expected when the bot isn't yet an admin of the configured channel.
import { Bot, InlineKeyboard } from "grammy";
import { env } from "./config.js";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { BRAND, SERIES, type Weekday } from "./post-theme.js";
import { trackedMiniAppLink } from "./post-buttons.js";

const SETTING_PREFIX = "pinnedWelcome:";
export const PINNED_WELCOME_SWEEP_MS = 6 * 60 * 60_000; // 6h tick; content-hash gate keeps quiet days free

/** Escape a string for safe use inside HTML parse_mode captions. */
export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

/** Tracked deep link per plan §Mini App tracked links — EXACTLY the same grammar as
 *  post-buttons.ts trackedMiniAppLink(): https://t.me/<bot>?startapp=post_<slug>_<c|s>.
 *  The Mini App (apps/web main.tsx) parses start_param with /^post_.+_(c|s)$/ and
 *  resolves the slug via /api/posts/slug/:slug, so anything else would dead-end.
 *  A "_" separator before the detail keeps that regex intact: the app strips _c/_s and
 *  the leftover "slug_detail" simply fails slug lookup → home feed, while the VIEW event
 *  still records source="c" under the welcome post's own attribution row. */
export function trackedWelcomeLink(slug: string, detail: string): string | null {
  if (!env.TELEGRAM_BOT_USERNAME || !env.WEBAPP_URL || env.WEBAPP_URL === "*") return null;
  return trackedMiniAppLink(`${slug}_${detail}`, "c");
}

/** Home-feed fallback link used for any button whose target view doesn't exist yet. */
function appHomeLink(): string | null {
  if (!env.TELEGRAM_BOT_USERNAME || !env.WEBAPP_URL || env.WEBAPP_URL === "*") return null;
  return trackedMiniAppLink("pinned-welcome", "c");
}

/** Bilingual caption (brand voice rule: Amharic and English never mixed IN a sentence —
 *  separate blocks are fine and are how the whole channel reads). */
export function buildWelcomeCaption(): string {
  const seriesLines = Object.values(SERIES).map((s) => `• ${s.chip} — every ${WEEKDAY_LABELS[s.day]}`);
  const lines = [
    `<b>${escHtml(BRAND.mark)}</b>`,
    "",
    "English — Welcome to GENZI Ethiopia. Tap a button below:",
    "🌐 <b>App</b> — posts, community, wallet & quizzes",
    "💰 <b>Opportunities</b> — money drops with deadlines",
    "🔥 <b>Trending</b> — what the community is reading now",
    "",
    "አማርኛ — ወደ ገንዚ ኢትዮጵያ በሰላም መጡ። ከታች ያለውን ቁልፍ ይንኩ፦",
    "🌐 <b>መተግበሪያ</b> — ልጥፎች፣ ማህበረሰብ፣ ጤና እና ጥያቄዎች",
    "💰 <b>እድሎች</b> — ቀጠሮ ያላቸው የገንዘብ ዕድሎች",
    "🔥 <b>ተወዳጅ</b> — ማህበረሰቡ በአሁኑ ሰዓት የሚያነበው",
  ];
  if (seriesLines.length > 0) {
    lines.push("", "<b>Recurring series 📌</b>", ...seriesLines);
  }
  lines.push("", `<i>${escHtml(BRAND.channelHandle)}</i>`);
  return lines.join("\n");
}

/** Three main buttons (plan §Pinned post). Returns null when the bot username or
 *  webapp URL is unconfigured — a welcome post whose main button dead-links is worse
 *  than none, and the next sweep retries once config lands.
 *
 *  Honest-destination rule: the Mini App today has one deep-link target (a post slug;
 *  unknown slugs land on home). So "Open GENZI App" is the only web_app button; the
 *  other two main destinations ride tracked t.me links that open the app's home feed
 *  with correct _c attribution, until dedicated views gain deep-link support. */
export function buildWelcomeKeyboard(): InlineKeyboard | null {
  const home = appHomeLink();
  if (!home) return null;
  return new InlineKeyboard()
    .webApp("🌐 Open GENZI App · መተግበሪያ ይክፈቱ", env.WEBAPP_URL)
    .row()
    .url("💰 Opportunities · እድሎች", trackedWelcomeLink("pinned-welcome", "opportunities") ?? home)
    .url("🔥 Trending · ተወዳጅ", trackedWelcomeLink("pinned-welcome", "trending") ?? home);
}

interface StoredWelcome {
  messageId?: number;
  signature?: string;
}

/**
 * One refresh pass. Idempotent: only talks to Telegram when the composed content
 * actually changed (content-hash gate) or the pinned message went missing.
 */
export async function refreshPinnedWelcome(bot: Bot): Promise<{ refreshed: boolean; reason?: string }> {
  try {
    if (!env.GENZI_CHANNEL_ID) return { refreshed: false, reason: "no-channel" };
    const caption = buildWelcomeCaption();
    const kb = buildWelcomeKeyboard();
    if (!kb) return { refreshed: false, reason: "no-webapp-config" };
    const signature = hashOf(caption + JSON.stringify(kb));

    const settingKey = SETTING_PREFIX + env.GENZI_CHANNEL_ID;
    const row = await db.setting.findUnique({ where: { key: settingKey } }).catch(() => null);
    const stored: StoredWelcome | null = row?.value ? safeParse(row.value) : null;

    if (stored?.messageId && stored.signature === signature) {
      // Content unchanged. Verify the message still exists AND is still pinned —
      // an admin may have deleted or unpinned it. pinChatMessage is idempotent on
      // Telegram's side, so re-pinning a still-pinned post costs one harmless call.
      try {
        await bot.api.pinChatMessage(env.GENZI_CHANNEL_ID, stored.messageId, { disable_notification: true });
        return { refreshed: false, reason: "unchanged-and-pinned" };
      } catch (pinError) {
        const text = String(pinError);
        // Rights problem: the message is fine, we just can't (re)pin. Re-sending would
        // churn channel history on every sweep — stop here and let an admin fix rights.
        if (/not enough rights|CHAT_ADMIN|chat administrator/i.test(text)) {
          return { refreshed: false, reason: "pin-rights-missing" };
        }
        // Anything else (message deleted by an admin, bad message id) → fall through
        // and post a fresh welcome next to it.
      }
    }

    // Post fresh (or replace after deletion): send → pin → delete previous → record.
    const msg = await bot.api.sendMessage(env.GENZI_CHANNEL_ID, caption, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    });
    await bot.api.pinChatMessage(env.GENZI_CHANNEL_ID, msg.message_id, { disable_notification: true }).catch((e) =>
      logger.warn("pinned welcome could not be pinned (bot needs pin rights)", { error: String(e) }),
    );
    if (stored?.messageId && stored.messageId !== msg.message_id) {
      await bot.api.deleteMessages(env.GENZI_CHANNEL_ID, [stored.messageId]).catch(() => {});
    }
    const ledger = JSON.stringify({ messageId: msg.message_id, signature });
    await db.setting
      .upsert({ where: { key: settingKey }, update: { value: ledger }, create: { key: settingKey, value: ledger } })
      .catch((e) => logger.warn("pinned welcome ledger write failed (may duplicate next sweep)", { error: String(e) }));
    logger.info("pinned welcome post refreshed", { messageId: msg.message_id });
    return { refreshed: true };
  } catch (error) {
    logger.warn("pinned welcome refresh skipped (non-fatal)", { error: String(error) });
    return { refreshed: false, reason: "error" };
  }
}

function hashOf(s: string): string {
  // FNV-1a — only used to detect "did the composed content change".
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function safeParse(s: string): StoredWelcome | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as StoredWelcome) : null;
  } catch {
    return null;
  }
}

/** Interval wiring, mirroring startSeriesScheduler / startReminderSweeper. */
export function startPinnedWelcomeLoop(bot: Bot): NodeJS.Timeout {
  // Fire once shortly after boot so the welcome exists without waiting a full sweep.
  setTimeout(() => void refreshPinnedWelcome(bot), 5_000).unref?.();
  const timer = setInterval(() => {
    void refreshPinnedWelcome(bot).catch((error) => logger.error("pinned welcome sweep crashed", { error: String(error) }));
  }, PINNED_WELCOME_SWEEP_MS);
  timer.unref?.();
  return timer;
}
