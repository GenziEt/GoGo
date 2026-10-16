# GENZI Reporting

Users can report a published post, another user (`POST /api/users/:id/report`), or a specific direct message (`POST /api/messages/:messageId/report`) from the Mini App. Reports are stored in the database configured by `DATABASE_URL` — SQLite for local development (`file:./dev.db`, the default in `schema.postgres.prisma`) and Postgres in production once the datasource provider is switched — via the Prisma models `Report` (posts) and `DirectMessageReport` (DMs). They are visible to authenticated owner/moderator accounts through the admin panel's reports queue and "ሪፖርት DM" tab.

Supported reasons:
- SPAM
- SCAM
- HARASSMENT
- SEXUAL_CONTENT
- NON_CONSENSUAL_INTIMATE_CONTENT
- DOXXING
- THREATS
- HATE
- DANGEROUS_CONTENT
- OTHER

Reports are not automatically treated as proof of a violation. Moderators review the report and may dismiss it or remove the reported post.
