import { db } from "./db.js";
import type { Locale } from "./i18n.js";
import type { Locale as PrismaLocale } from "@prisma/client";

export type Step = "title" | "body" | "media" | "link" | "category" | "preview";
// Confirms the post wizard's /skip command (media + link steps) and nothing else — the
// confession flow treats any "/..." as a pass-through command.
export const POST_WIZARD_STEPS: readonly Step[] = ["title", "body", "media", "link", "category", "preview"] as const;
export type ConfessionStep = "confession_body" | "confession_confirm";

export function toPrismaLocale(locale: Locale): PrismaLocale {
  return locale === "en" ? "ENGLISH" : "AMHARIC";
}

export function fromPrismaLocale(locale: PrismaLocale): Locale {
  return locale === "ENGLISH" ? "en" : "am";
}

export async function setSession(
  telegramUserId: number,
  submissionId: string,
  step: Step,
  locale: Locale
) {
  const dbLocale = toPrismaLocale(locale);
  return db.conversationSession.upsert({
    where: { telegramUserId: String(telegramUserId) },
    update: { submissionId, confessionId: null, step, locale: dbLocale },
    create: {
      telegramUserId: String(telegramUserId),
      step,
      locale: dbLocale,
      // ✅ All relations use connect — no scalar FKs mixed in
      user: {
        connect: { telegramId: String(telegramUserId) },
      },
      submission: {
        connect: { id: submissionId },
      },
    },
  });
}

export async function setConfessionSession(
  telegramUserId: number,
  confessionId: string,
  step: ConfessionStep,
  locale: Locale
) {
  const dbLocale = toPrismaLocale(locale);
  return db.conversationSession.upsert({
    where: { telegramUserId: String(telegramUserId) },
    update: { confessionId, submissionId: null, step, locale: dbLocale },
    create: {
      telegramUserId: String(telegramUserId),
      step,
      locale: dbLocale,
      // ✅ All relations use connect — no scalar FKs mixed in
      user: {
        connect: { telegramId: String(telegramUserId) },
      },
      confession: {
        connect: { id: confessionId },
      },
    },
  });
}

// Sessions expire after 30 minutes of inactivity so an abandoned wizard can't swallow the
// user's later messages indefinitely.
const SESSION_TTL_MS = 30 * 60 * 1000;

export async function getSession(telegramUserId: number) {
  const session = await db.conversationSession.findUnique({
    where: { telegramUserId: String(telegramUserId) },
  });
  if (!session) return null;
  if (Date.now() - session.updatedAt.getTime() > SESSION_TTL_MS) {
    await clearSession(telegramUserId);
    return null;
  }
  return session;
}

// Starting a new flow closes whatever the user left half-finished, so orphan INPUT/PREVIEW
// rows don't accumulate. (Mini App confessions are created with a body in INPUT and are
// published through the API, so only body-less INPUT rows are touched.)
export async function abandonOpenWork(userId: string) {
  await db.submission.updateMany({ where: { userId, state: "INPUT" }, data: { state: "REJECTED" } });
  await db.confession.updateMany({
    where: { userId, OR: [{ state: "INPUT", body: null }, { state: "PREVIEW" }] },
    data: { state: "REJECTED" },
  });
}

export async function clearSession(telegramUserId: number) {
  await db.conversationSession.deleteMany({
    where: { telegramUserId: String(telegramUserId) },
  });
}