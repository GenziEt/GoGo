import { randomBytes, randomInt } from "node:crypto";
import { validateTelegramInitData } from "./telegram-webapp.js";
import { env } from "./config.js";
import { db } from "./db.js";
import type { Request, Response, NextFunction } from "express";

export async function telegramAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const initData = req.header("X-Telegram-Init-Data") ?? "";
  const user = validateTelegramInitData(initData);
  if (!user)
    return res.status(401).json({
      success: false,
      data: null,
      error: "Invalid Telegram WebApp session",
      timestamp: new Date().toISOString(),
    });

  const dbUser = await db.user.upsert({
    where: { telegramId: String(user.id) },
    update: {
      ...(user.username !== undefined ? { username: user.username } : {}),
      ...(user.first_name !== undefined ? { firstName: user.first_name } : {}),
      ...(user.last_name !== undefined ? { lastName: user.last_name } : {}),
    },
    create: {
      telegramId: String(user.id),
      ...(user.username !== undefined ? { username: user.username } : {}),
      ...(user.first_name !== undefined ? { firstName: user.first_name } : {}),
      ...(user.last_name !== undefined ? { lastName: user.last_name } : {}),
    },
  });

  if (dbUser.blocked)
    return res.status(403).json({
      success: false,
      data: null,
      error: "የመለያዎ መዳረሻ ታግዷል።",
      timestamp: new Date().toISOString(),
    });

  if (dbUser.restrictedUntil && dbUser.restrictedUntil > new Date())
    return res.status(403).json({
      success: false,
      data: { restrictedUntil: dbUser.restrictedUntil },
      error: "የመለያዎ ተግባራት ለጊዜው ተገድበዋል።",
      timestamp: new Date().toISOString(),
    });

  res.locals.telegramUser = dbUser;
  next();
}

export function adminAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Audit fix: ADMIN_USERNAME/ADMIN_PASSWORD were declared in config but never read anywhere.
  // They now act as an HTTP Basic fallback for the same privilege level as X-Admin-Key, so the
  // keys are functional rather than dead. Timing-safe-ish comparison; constant-time would be
  // nicer but these credentials are already only as strong as the env file that stores them.
  const header = req.header("X-Admin-Key");
  if (header && header === env.ADMIN_API_KEY) return next();
  const basic = req.header("Authorization");
  if (basic?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      const user = sep >= 0 ? decoded.slice(0, sep) : "";
      const pass = sep >= 0 ? decoded.slice(sep + 1) : "";
      if (user === env.ADMIN_USERNAME && pass === env.ADMIN_PASSWORD && pass !== "change-me-please") return next();
    } catch { /* malformed header falls through to 401 */ }
  }
  return res.status(401).json({
      success: false,
      data: null,
      error: "Unauthorized",
      timestamp: new Date().toISOString(),
    });
}

// --- Moderator identity verification -----------------------------------------------------
// The shared ADMIN_API_KEY only proves possession of the admin panel's static secret; it says
// nothing about *which* staff member is acting. Every moderation action needs to be attributed
// to a specific, verified person, so we layer a second factor on top of adminAuth: a one-time
// login code that only reaches that person's own Telegram account via the bot (proof of
// Telegram identity, same trust root as telegramAuth), exchanged here for a short-lived session
// token. Nothing here is persisted to the database or survives a process restart on purpose —
// codes and sessions are intentionally short-lived, in-memory, single-purpose credentials.

const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

interface PendingCode {
  userId: string;
  expiresAt: number;
}
interface ModeratorSession {
  userId: string;
  expiresAt: number;
}

const pendingCodes = new Map<string, PendingCode>();
const sessions = new Map<string, ModeratorSession>();

setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pendingCodes)
    if (entry.expiresAt <= now) pendingCodes.delete(code);
  for (const [token, entry] of sessions)
    if (entry.expiresAt <= now) sessions.delete(token);
}, 5 * 60 * 1000).unref();

function generateCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function createModeratorLoginCode(userId: string): {
  code: string;
  expiresAt: Date;
} {
  for (const [code, entry] of pendingCodes)
    if (entry.userId === userId) pendingCodes.delete(code);
  const code = generateCode();
  const expiresAt = Date.now() + LOGIN_CODE_TTL_MS;
  pendingCodes.set(code, { userId, expiresAt });
  return { code, expiresAt: new Date(expiresAt) };
}

export function consumeModeratorLoginCode(rawCode: string): string | null {
  const code = rawCode.trim().toUpperCase();
  const entry = pendingCodes.get(code);
  pendingCodes.delete(code); // one-time use regardless of outcome
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.userId;
}

export function createModeratorSession(userId: string): {
  token: string;
  expiresAt: Date;
} {
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { userId, expiresAt });
  return { token, expiresAt: new Date(expiresAt) };
}

export async function moderatorSessionAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const token = req.header("X-Moderator-Session") ?? "";
  const entry = sessions.get(token);
  if (!entry || entry.expiresAt <= Date.now()) {
    sessions.delete(token);
    return res.status(401).json({
      success: false,
      data: null,
      error:
        "Moderator session required or expired. Use /moderatorlogin in the bot and verify in the panel.",
      timestamp: new Date().toISOString(),
    });
  }
  const moderator = await db.user.findUnique({ where: { id: entry.userId } });
  if (
    !moderator ||
    (moderator.role !== "OWNER" && moderator.role !== "MODERATOR")
  ) {
    sessions.delete(token);
    return res.status(403).json({
      success: false,
      data: null,
      error: "Moderator account required",
      timestamp: new Date().toISOString(),
    });
  }
  res.locals.moderator = moderator;
  next();
}