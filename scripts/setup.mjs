import fs from "node:fs";
import path from "node:path";

const env = path.resolve(".env");
if (!fs.existsSync(env)) {
  fs.copyFileSync(".env.example", env);
  console.log("Created .env from .env.example. Add your Telegram bot token and owner ID.");
} else {
  console.log(".env already exists.");
}
