import { db } from "./db.js";
import type { Locale } from "./i18n.js";
import type { Locale as PrismaLocale } from "@prisma/client";

export type Step = "title" | "body" | "media" | "link" | "category" | "facts" | `fact:${string}:${string}` | "preview";
// Wizard steps that accept free TEXT input (everything except the preview).
// The "facts" step is a review screen driven by inline buttons; each
// "fact:<category>:<key>" sub-step collects one structured fact-block value as text.
const TEXT_INPUT_STEPS: readonly string[] = ["title", "body", "media", "link", "category"];
export function isTextInputStep(step: string): boolean {
  return TEXT_INPUT_STEPS.includes(step) || step.startsWith("fact:");
}
// "/skip" is meaningful on these steps: media and link are optional overall steps,
// and an individual fact field can be cleared back to Missing with /skip.
export function isSkipAllowedStep(step: string): boolean {
  return step === "media" || step === "link" || step.startsWith("fact:");
}
// Confirms the post wizard's /skip command (media + link steps) and nothing else — the
// confession flow treats any "/..." as a pass-through command.
export const POST_WIZARD_STEPS: readonly Step[] = ["title", "body", "media", "link", "category", "facts", "preview"] as const;
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

// Phase 2 (plan §2.3): the author's "use mine" vs "use GENZI card" choice, persisted
// on the session row. setSession upserts by telegramUserId and never touches this
// column, so re-entering a step (e.g. edit → preview) keeps the stored choice.
export async function setPreferCard(telegramUserId: number, preferCard: boolean): Promise<void> {
  await db.conversationSession.update({
    where: { telegramUserId: String(telegramUserId) },
    data: { preferCard },
  });
}