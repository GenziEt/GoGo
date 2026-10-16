import { env } from "./config.js";

export type LogLevel = "info" | "warn" | "error";

// Audit fix: LOG_LEVEL was defined in config but never read — the logger always emitted
// everything. Now it honors env.LOG_LEVEL so debugging noise can be turned down/up.
const ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const threshold = ORDER[env.LOG_LEVEL] ?? 0;

function write(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: "genzi-bot",
    message,
    ...fields
  };
  const output = JSON.stringify(entry);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

export const logger = {
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields)
};
