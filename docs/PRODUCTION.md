# GENZI v0.2.9 — Production & Reliability

## Runtime modes
GENZI supports Telegram polling for local development and webhook mode for production.

Set `BOT_MODE=webhook`, `BOT_WEBHOOK_URL` to the public HTTPS origin, and a random `BOT_WEBHOOK_SECRET` of at least 16 characters. The bot registers the webhook at `BOT_WEBHOOK_PATH` and validates Telegram's secret token.

## Health endpoints
- `GET /health` — process/liveness check.
- `GET /ready` — readiness check including a database query.
- `GET /api/admin/diagnostics` — authenticated operational diagnostics.

Put a reverse proxy/load balancer in front of the service and expose `/health` and `/ready` to your orchestrator. Keep the admin diagnostics endpoint protected.

## Database
The development schema remains SQLite. A PostgreSQL-ready schema is included at `apps/bot/prisma/schema.postgres.prisma`.

Generate the PostgreSQL Prisma client with:

```bash
npm run prisma:generate:postgres -w apps/bot
```

Push the PostgreSQL schema when the PostgreSQL `DATABASE_URL` is configured:

```bash
npm run prisma:push:postgres -w apps/bot
```

For an existing production database, prefer reviewed Prisma migrations rather than using `db push` blindly. Validate schema changes and take a backup before every migration.

## Using Supabase as the Postgres host
Supabase gives you a managed Postgres instance that works as a drop-in `DATABASE_URL` for `schema.postgres.prisma` — no application code changes needed.

1. Create a project at supabase.com (free tier: 500MB database, 2 projects per account, commercial use permitted).
2. Project Settings → Database → Connection string → **Session mode** (not "Direct connection", not "Transaction mode"). Session mode works over both IPv4 and IPv6; Supabase's direct-connection host is IPv6-only, which fails outright on VPS providers without IPv6 routing. Session mode also avoids the `?pgbouncer=true` prepared-statement caveat that Transaction mode (port 6543) requires — Transaction mode is meant for serverless/edge functions making many short-lived connections, not a persistent Express process like this one.
3. Set that as `DATABASE_URL`, then run `npm run db:generate:postgres && npm run db:push:postgres`.
4. **Free-tier projects pause after 7 days with zero API/database activity**, and only resume via a manual click in the Supabase dashboard — a real risk during low-traffic testing or a quiet week, not just a theoretical one. The simplest keepalive is to schedule an HTTP request to your own bot's public health endpoint (e.g. `GET /health` on Render's free cron jobs or any external ping service) so the app touches the database regularly; that requires no extra secrets. A GitHub Actions workflow could do the same, but note this repository does not currently ship `.github/workflows/supabase-keepalive.yml`, and it would need `SUPABASE_PROJECT_URL`/`SUPABASE_ANON_KEY` set as repository secrets for a direct REST ping (the anon key is safe there since it can only do what your Row Level Security policies allow, and this project doesn't rely on Supabase's own RLS/Auth for anything).

## Backups
For SQLite, stop the service and run:

```bash
npm run db:backup
```

The backup is written under `backups/`. PostgreSQL deployments should use `pg_dump` and a tested restore procedure. Keep backups outside the application container and encrypt them at rest.

## Configuration hardening
Production startup rejects default admin secrets and requires webhook configuration when webhook mode is enabled. Set `TRUST_PROXY=true` only when GENZI is actually behind a trusted reverse proxy; this makes Express use forwarded client information for rate limiting.

Never commit `.env`, Telegram bot tokens, database credentials, admin keys, or webhook secrets.

## Graceful shutdown
SIGINT/SIGTERM stop Telegram polling/webhook registration, disconnect Prisma, and close the HTTP server. `SHUTDOWN_TIMEOUT_MS` bounds shutdown time.

## Logging
GENZI emits structured JSON logs with timestamp, level, service and event fields so container platforms can collect them without a paid logging service.

## Deployment checklist
- HTTPS terminated by a trusted reverse proxy.
- Strong unique `ADMIN_API_KEY`, `ADMIN_PASSWORD`, and webhook secret.
- PostgreSQL configured for production durability.
- Automated encrypted backups plus a restore test.
- `GET /health` and `GET /ready` monitored.
- `BOT_MODE=webhook` for production Telegram delivery.
- `TRUST_PROXY` configured correctly for the deployment topology.
- Telegram bot and channel/group administrator permissions verified.
- Database migrations reviewed before deployment.
- No secrets in source control.
