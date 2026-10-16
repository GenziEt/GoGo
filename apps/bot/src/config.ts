import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default("file:./dev.db"),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_ID: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  GENZI_CHANNEL_ID: z.string().optional(),
  // Public @handle of the GENZI channel (no @). Needed to build t.me/<handle>/<messageId>
  // share links; when unset the 🔗 Share button is silently skipped on channel posts.
  GENZI_CHANNEL_USERNAME: z.string().optional(),
  // Full t.me/... link to the GENZI discussion group; when unset the 💬 Discuss button is
  // silently skipped (graceful degradation, no crashes).
  GENZI_DISCUSSION_URL: z.string().url().optional(),
  GENZI_GROUP_ID: z.string().optional(),
  WEBAPP_URL: z.string().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().optional(),
  PUBLIC_API_URL: z.string().default("http://localhost:3000"),
  ADMIN_API_KEY: z.string().default("change-me-api-key"),
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD: z.string().min(8).default("change-me-please"),
  TRUST_PROXY: z.coerce.boolean().default(false),
  LOG_LEVEL: z.enum(["info", "warn", "error"]).default("info"),
  BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
  BOT_WEBHOOK_URL: z.string().url().optional(),
  BOT_WEBHOOK_PATH: z.string().regex(/^\/[A-Za-z0-9._~-]+$/).default("/webhook"),
  BOT_WEBHOOK_SECRET: z.string().min(16).optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000)
});

export const env = envSchema.parse(process.env);

if (env.NODE_ENV === "production") {
  if (env.ADMIN_API_KEY === "change-me-api-key") throw new Error("ADMIN_API_KEY must be changed in production");
  if (env.ADMIN_PASSWORD === "change-me-please") throw new Error("ADMIN_PASSWORD must be changed in production");
  if (env.BOT_MODE === "webhook" && (!env.BOT_WEBHOOK_URL || !env.BOT_WEBHOOK_SECRET)) {
    throw new Error("BOT_WEBHOOK_URL and BOT_WEBHOOK_SECRET are required for webhook mode");
  }
}

