import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";
if (!databaseUrl.startsWith("file:")) {
  console.error("This backup script supports SQLite file URLs only. Use pg_dump for PostgreSQL.");
  process.exit(1);
}
const source = resolve("apps/bot/prisma", databaseUrl.slice(5));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = resolve("backups", `genzi-${stamp}.db`);
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log(`SQLite backup created: ${destination}`);
