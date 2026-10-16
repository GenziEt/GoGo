// Telegram notification fan-out (docs commit: "Add Telegram notification service for
// comments, follows, DMs, referrals, and events").
//
// The in-app Notification table is the durable record; this module additionally pushes a
// short message to the recipient's private Telegram chat so users who do not keep the Mini
// App open still learn about activity. Delivery is strictly best-effort: any failure (user
// blocked the bot, network hiccup) is swallowed after being logged — notifications must
// never break the request that produced them.
import type { Bot } from "grammy";
import { db } from "./db.js";
import { logger } from "./logger.js";

type NotifyInput = { title: string; body: string };

export function createTelegramNotifier(bot: Bot) {
  async function notifyUser(userId: string, input: NotifyInput): Promise<void> {
    try {
      const target = await db.user.findUnique({ where: { id: userId }, select: { telegramId: true, blocked: true } });
      if (!target || target.blocked) return;
      await bot.api.sendMessage(target.telegramId, `🇪🇹 GENZI\n\n${input.title}\n${input.body}`, { link_preview_options: { is_disabled: true } });
    } catch (error) {
      logger.warn("telegram notification delivery skipped", { userId, error: String(error) });
    }
  }

  // Convenience wrappers matching the event classes named in the feature commit.
  return {
    notifyUser,
    comment: (userId: string, actorName: string | null | undefined, postTitle: string) =>
      notifyUser(userId, { title: "💬 አዲስ አስተያየት", body: `${actorName ?? "GENZI ተጠቃሚ"} በ"${postTitle}" ላይ አስተያየት ሰጠ።` }),
    follow: (userId: string, actorName: string | null | undefined) =>
      notifyUser(userId, { title: "👥 አዲስ ተከታይ", body: `${actorName ?? "አንድ ተጠቃሚ"} እርስዎን ተከተለው።` }),
    directMessage: (userId: string, actorName: string | null | undefined) =>
      notifyUser(userId, { title: "✉️ አዲስ መልዕክት", body: `${actorName ?? "አንድ ተጠቃሚ"} የግል መልዕክት ላክልዎ።` }),
    referral: (userId: string) =>
      notifyUser(userId, { title: "🎁 የመጋበዣ ሽልማት", body: "አዲስ ሰው በኮድዎ GENZIን ተቀላቅሏል — ሪንቦዎ ተመዝግቧል!" }),
    eventStartingSoon: (userId: string, title: string, startsAt: Date) =>
      notifyUser(userId, { title: "⏰ ዝግጅት ይጀምራል", body: `"${title}" በ ${startsAt.toLocaleString("am-ET")} ይጀምራል።` })
  };
}

export type TelegramNotifier = ReturnType<typeof createTelegramNotifier>;
