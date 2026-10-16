import type { Request, Response, NextFunction } from "express";
import { moderateText, type ModerationResult } from "./moderation.js";
import { db } from "./db.js";

const buckets = new Map<string, { startedAt: number; count: number }>();
const WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;
let lastCleanup = Date.now();
const LIMITS: Record<string, number> = {
  GET: 120,
  POST: 30,
  PATCH: 20,
  DELETE: 20
};

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  // The Telegram webhook (POST /webhook) used to fall under the 30 POST/min bucket, so on a busy
  // bot Telegram's updates were answered with 429 and button taps/messages were dropped. It is
  // protected by the webhook secret token instead. Preflights and health checks are exempt too.
  if (req.method === "OPTIONS" || req.path === "/health" || req.path === (process.env.BOT_WEBHOOK_PATH ?? "/webhook")) {
    next();
    return;
  }
  // req.ip already reflects X-Forwarded-For when (and only when) Express's own
  // "trust proxy" setting is enabled (see app.set("trust proxy", env.TRUST_PROXY) in index.ts).
  // We deliberately do NOT read the header ourselves here: doing so would let any client spoof
  // X-Forwarded-For to get a fresh rate-limit bucket on every request, regardless of TRUST_PROXY.
  const key = `${req.ip || "unknown"}:${req.method}:${req.path}`;
  const now = Date.now();
  if (now - lastCleanup >= CLEANUP_INTERVAL_MS) {
    for (const [bucketKey, value] of buckets) {
      if (now - value.startedAt >= WINDOW_MS) buckets.delete(bucketKey);
    }
    lastCleanup = now;
  }
  const bucket = buckets.get(key);
  const limit = LIMITS[req.method] ?? 20;
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    buckets.set(key, { startedAt: now, count: 1 });
    next();
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - bucket.startedAt)) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ success: false, data: null, error: "በጣም ብዙ ጥያቄዎች ተልከዋል። እባክዎ ትንሽ ይጠብቁ።", timestamp: new Date().toISOString() });
    return;
  }
  next();
}

export function moderateRequestText(text: string, isAdmin: boolean): ModerationResult {
  return moderateText(text, { isAdmin, isForwarded: false });
}

export function collectTextValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectTextValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectTextValues);
  return [];
}

export type ModerationOutcome =
  | { ok: true }
  // A QUARANTINE outcome is not an error: the content was accepted but held for moderator
  // review instead of being published/visible immediately. Callers should surface
  // quarantined=true to the client (the admin queue then shows the item).
  | { ok: true; quarantined: true; category: string; reason: string }
  | { ok: false; status: number; error: string };

// Shared enforcement path for every user-generated-content endpoint (comments, DMs, confessions,
// communities, events, opportunities, polls, quizzes, ...). Runs the same keyword/link/threat
// checks and applies the same escalation (moderation-event logging, ban on hard violations,
// temporary restriction after repeated violations) everywhere, so no endpoint can accidentally
// ship without it.
// Runs the moderation rules AND applies the escalation (event log, ban on hard violations,
// temporary restriction after repeated rejects). Returns the raw ModerationResult so callers
// that need locale-specific replies (the bot flows) can word the response themselves.
export async function moderateAndEnforce(userId: string, isAdmin: boolean, texts: string[]): Promise<ModerationResult> {
  const evidence = texts.filter((t) => typeof t === "string" && t.trim().length > 0).join("\n").slice(0, 4000);
  if (!evidence) return { decision: "ALLOW", category: "NONE", reason: "No text to check.", score: 0 };
  const result = moderateText(evidence, { isAdmin, isForwarded: false });

  if (result.decision === "BAN" || result.decision === "REJECT") {
    const action = result.decision === "BAN" ? "BAN" : "REJECT";
    await db.moderationEvent.create({ data: { targetUserId: userId, category: result.category, action, reason: result.reason, evidence } });
    if (action === "BAN") {
      await db.user.update({ where: { id: userId }, data: { blocked: true } });
    } else {
      const recent = await db.moderationEvent.count({
        where: { targetUserId: userId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, action: { in: ["REJECT", "BAN"] } }
      });
      if (recent >= 3) await db.user.update({ where: { id: userId }, data: { restrictedUntil: new Date(Date.now() + 60 * 60 * 1000) } });
    }
  } else if (result.decision === "QUARANTINE") {
    // Held for human review: callers keep the content out of public visibility.
    await db.moderationEvent.create({ data: { targetUserId: userId, category: result.category, action: "QUARANTINE", reason: result.reason, evidence } });
  }
  return result;
}

export async function enforceContentModeration(userId: string, isAdmin: boolean, texts: string[]): Promise<ModerationOutcome> {
  const result = await moderateAndEnforce(userId, isAdmin, texts);
  if (result.decision === "BAN" || result.decision === "REJECT") {
    const error = result.category === "LINK"
      ? "🔒 ይህ አገናኝ በGENZI የፍቃድ ዝርዝር ላይ የለም። ከተፈቀዱ ድረ-ገጾች (ለምሳሌ YouTube፣ Instagram፣ Google Docs) የመጡ አገናኞች ብቻ ይፈቀዳሉ።"
      : "ይህ ይዘት በGENZI የደህንነት መመሪያ መሠረት ውድቅ ተደርጓል።";
    return { ok: false, status: 400, error };
  }
  if (result.decision === "QUARANTINE") return { ok: true, quarantined: true, category: result.category, reason: result.reason };
  return { ok: true };
}
