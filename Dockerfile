FROM node:20-alpine

WORKDIR /app

# 1. Copy root package files (include package-lock.json if you have one)
COPY package.json package-lock.json* tsconfig.base.json ./

# 2. Copy the entire apps directory (includes apps/bot/prisma/schema.postgres.prisma)
COPY apps ./apps

# 3. Install dependencies for the whole workspace
RUN npm install

# 4. CRITICAL: Generate Prisma types using the absolute path to the schema
# Removing the -w flag prevents the working directory from changing and breaking the path
RUN npx prisma generate --schema=/app/apps/bot/prisma/schema.postgres.prisma

# 5. Build the project (TypeScript will now successfully find User, Locale, etc.)
RUN npm run build

# 6. Healthcheck (ensure port 3000 matches your bot's actual listening port)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:10000/health || exit 1

# 7. Start the bot workspace
CMD ["npm", "run", "start", "-w", "apps/bot"]
