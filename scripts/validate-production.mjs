import process from "node:process";

const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID", "DATABASE_URL", "WEBAPP_URL", "PUBLIC_API_URL", "ADMIN_API_KEY", "ADMIN_PASSWORD"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
if (process.env.NODE_ENV === "production") {
  if (process.env.ADMIN_API_KEY === "change-me-api-key") throw new Error("ADMIN_API_KEY must be changed");
  if (process.env.ADMIN_PASSWORD === "change-me-please" || process.env.ADMIN_PASSWORD === "change-me") throw new Error("ADMIN_PASSWORD must be changed");
  if (process.env.BOT_MODE === "webhook" && (!process.env.BOT_WEBHOOK_URL || !process.env.BOT_WEBHOOK_SECRET)) throw new Error("Webhook mode requires BOT_WEBHOOK_URL and BOT_WEBHOOK_SECRET");
}
console.log("GENZI configuration validation passed.");
