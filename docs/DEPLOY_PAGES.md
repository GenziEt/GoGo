# Deploying the frontends to GitHub Pages

This repo stays **private**. GitHub Pages on a free personal account only serves
from **public** repos, so `.github/workflows/deploy-pages.yml` builds both
`apps/web` (the Mini App) and `apps/admin` here, then pushes just the compiled
static output to a second, public repo dedicated to Pages hosting. No source
code is exposed by this — a deployed frontend's JS is already fully readable in
any visitor's browser dev tools, regardless of whether the source repo is
public or private.

## One-time setup

1. **Create the public repo.** On GitHub: New repository → name it (e.g.
   `genzi-pages`) → **Public** → no README needed, the workflow creates
   everything. Note the full `owner/repo` — you'll need it below.

2. **Create a deploy token.** GitHub → your avatar → Settings → Developer
   settings → Personal access tokens → **Tokens (classic)** → Generate new
   token → scope: **repo** (full control, needed to push to the public repo) →
   set an expiration you're comfortable with → copy the token once, it won't
   be shown again.

3. **Add secrets/variables to *this* (private) repo** — Settings → Secrets
   and variables → Actions:
   - **Secret** `PAGES_DEPLOY_TOKEN` = the token from step 2
   - **Variable** `PAGES_REPO` = `owner/genzi-pages` (from step 1)
   - **Variable** `VITE_API_URL` = your backend's public HTTPS URL (e.g.
     `https://api.yourdomain.com`) — set once you've picked where the bot/API
     process runs; the site will build with whatever this currently points to

4. **Enable Pages on the public repo.** After the workflow runs once (it
   creates a `gh-pages` branch there), go to the public repo → Settings →
   Pages → Source: **Deploy from a branch** → Branch: `gh-pages` / `(root)`.

5. Your Mini App is now live at `https://owner.github.io/genzi-pages/`, and
   the admin panel at `https://owner.github.io/genzi-pages/admin/`.

## Wiring the Mini App into Telegram

Once the Pages URL is live, register it with BotFather so the bot's menu
button actually opens it:

1. `@BotFather` → `/mybots` → your bot → **Bot Settings** → **Menu Button** →
   set the URL to `https://owner.github.io/genzi-pages/`.
2. If you're using BotFather's dedicated Mini App flow instead
   (`/newapp`), point that at the same URL.

## Re-deploying

The workflow runs automatically on every push to `main` that touches
`apps/web/`, `apps/admin/`, or the workflow file itself. Trigger it manually
any time from the Actions tab → **Deploy frontends to GitHub Pages** → **Run
workflow**.

## If `VITE_API_URL` changes later

Update the `VITE_API_URL` repository variable, then re-run the workflow
manually (Actions tab → **Run workflow**) — the frontends bake the API URL in
at build time, so a redeploy is required after any change.
