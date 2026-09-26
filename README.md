# PdfClaudeAssistant

Self-hosted study assistant: a PDF reader with Claude as a tutor. Claude reads your
PDFs, answers with page citations, points at things on the page, highlights, builds
summaries and quizzes, remembers what you struggle with and schedules reviews.

Single user, runs on your own VPS. See [`SPEC.md`](SPEC.md) for the full product spec.

> **Claude runs through your Claude subscription (Pro/Max), never an API key.**
> The backend uses the Claude Agent SDK, which drives Claude Code with your
> subscription session. The server refuses to start if `ANTHROPIC_API_KEY` or
> `ANTHROPIC_AUTH_TOKEN` is set, and strips them from Claude Code's environment.
> Usage counts against the same limits as Claude Code and claude.ai.

## Deploying on a VPS

The app runs as **one container** (`pdfclaudeassistant-server`) that serves the web
app, the API and the chat WebSocket. It listens only on `127.0.0.1:${APP_PORT}`; a
reverse proxy on the host publishes it over HTTPS.

Requirements on the VPS: Docker with the Compose plugin, a reverse proxy (the
host's own Caddy is assumed below; see [bundled Caddy](#without-a-reverse-proxy-bundled-caddy)
otherwise) and a DNS name pointing at the VPS.

### Deploying from your PC (`scripts/deploy.ps1`)

Deploys run from a Windows PC over SSH. The script packs the **committed** code
(`git archive HEAD`), copies it with `scp`, swaps it into the deploy directory,
rebuilds and restarts the container, and waits for `/api/health`. It never
touches the server's `.env` or `data/`.

```powershell
$env:PCA_DEPLOY_HOST = 'root@<VPS_HOST>'   # required
# optional: $env:PCA_DEPLOY_DIR (default /opt/pdfclaudeassistant)
#           $env:PCA_SSH_KEY    (default $env:USERPROFILE\.ssh\id_ed25519)
.\scripts\deploy.ps1
```

It refuses to run with uncommitted changes (pass `-AllowDirty` to deploy `HEAD`
anyway). Database migrations run automatically when the server starts.

### First-time setup

1. Install Docker and the Compose plugin on the VPS.
2. Run `.\scripts\deploy.ps1` once. It copies the code to
   `/opt/pdfclaudeassistant`, creates `data/` (owned by uid 1000, the container
   user) and stops because `.env` does not exist yet.
3. On the VPS, create `.env`:

   ```bash
   cd /opt/pdfclaudeassistant
   cp .env.example .env
   docker compose build server
   docker compose run --rm --no-deps server node dist/hash-password.js 'your password'
   # -> APP_PASSWORD_HASH='$argon2id$v=19$...'   paste this line into .env
   ```

   | Variable                  | Value                                                                     |
   | ------------------------- | ------------------------------------------------------------------------- |
   | `APP_PORT`                | A free loopback port on the host (the proxy points here). Default 3000.   |
   | `APP_PASSWORD_HASH`       | Output of the command above, **inside single quotes** (the hash has `$`). |
   | `SESSION_SECRET`          | `openssl rand -hex 32`                                                    |
   | `CLAUDE_CODE_OAUTH_TOKEN` | Subscription token (method 1 below). Leave empty for method 2.            |
   | `CLAUDE_MODEL`            | Optional model alias/ID. Empty uses Claude Code's default.                |
   | `MAX_UPLOAD_MB`           | `0` = no limit.                                                           |
   | `OCR_LANGS`               | Tesseract languages, default `spa+eng`.                                   |

4. Run `.\scripts\deploy.ps1` again: it builds, starts and health-checks the app.
5. Add the site to the host Caddy: copy the block from
   [`deploy/host-caddy.example`](deploy/host-caddy.example) into the Caddyfile
   (your domain, and your `APP_PORT` if it is not 3000), then
   `systemctl reload caddy`. Behind Cloudflare (proxied), use SSL/TLS mode
   **Full (strict)**; uploads go in 32 MiB chunks, below Cloudflare's body limit.
6. Open `https://your-domain`, log in and check **Ajustes → Conexión con Claude**:
   it should say _Conectado con tu suscripción_.

### Backups

`docker compose exec -T server node dist/backup.js` writes
`data/backups/pdfclaudeassistant-backup-YYYY-MM-DD.tar.gz` (database snapshot,
PDFs and covers; the Claude session in `data/claude-home` is left out).
**Ajustes** also has a download button. A daily backup at 04:00 with cron
(`crontab -e` on the VPS):

```cron
0 4 * * * cd /opt/pdfclaudeassistant && docker compose exec -T server node dist/backup.js >> data/backups/cron.log 2>&1
```

Copy `data/backups/` somewhere off the VPS from time to time, and delete old
archives when they pile up.

### Operating

- Logs: `docker compose logs -f server` (lines prefixed `[PdfClaudeAssistant]`).
- Deployed revision: `cat /opt/pdfclaudeassistant/REVISION`.
- Everything that matters lives in `data/` (SQLite, PDFs, covers, Claude
  session). Deploys keep it; never delete it.
- Host-specific compose tweaks go in `docker-compose.override.yml` next to
  `docker-compose.yml`; deploys keep that file too.

### Without a reverse proxy (bundled Caddy)

On a host with nothing on ports 80/443, the optional bundled Caddy gets the
HTTPS certificate itself. Set `DOMAIN` in `.env` and start both services:

```bash
docker compose --profile caddy up -d
```

## Connecting Claude to your subscription

Two supported methods. Either way the credentials stay on the server and never
reach the browser.

### Method 1 — long-lived token (recommended)

1. On any machine with Claude Code installed, run:
   ```bash
   claude setup-token
   ```
2. Sign in with your Claude account in the browser window it opens.
3. Copy the token it prints into `.env`:
   ```bash
   CLAUDE_CODE_OAUTH_TOKEN=...
   ```
4. Apply it: `docker compose up -d` (recreates the server with the new env).

### Method 2 — interactive login inside the container

1. Start the stack: `docker compose up -d`
2. Open Claude Code in the server container:
   ```bash
   docker compose exec server claude
   ```
3. Type `/login`, choose your Claude subscription account and follow the link.
4. Exit Claude Code (`/exit`).

Credentials are stored in `./data/claude-home` (mounted as the container's
Claude config dir), so they survive restarts and image updates. This directory is
excluded from downloadable backups.

### When the session expires or you hit a limit

**Ajustes → Conexión con Claude** shows one of: connected, session expired, usage
limit reached. For an expired session repeat method 1 (new token, `docker compose up -d`)
or method 2. Usage limits reset on your subscription's schedule.

## Updating

Commit, then run `.\scripts\deploy.ps1` from your PC (see above). Database
migrations run automatically on startup.

## Development

Requirements: Node 22+, pnpm (`corepack enable`), and either a
`CLAUDE_CODE_OAUTH_TOKEN` or a local `claude` login for chat features.

```bash
pnpm install
cp .env.example .env   # set APP_PASSWORD_HASH, SESSION_SECRET and DATA_DIR=../../data
pnpm --filter @pdfclaudeassistant/server hash-password 'dev'
pnpm dev               # API on :3000, web on http://localhost:5173
```

Checks:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test              # unit tests, including the no-API-key guard
pnpm e2e               # Playwright (uses a fake Claude, no subscription needed)
```

Layout: `apps/server` (Fastify, SQLite, Claude Agent SDK), `apps/web` (React + Vite),
`packages/shared` (types shared by both). Conventions live in [`CLAUDE.md`](CLAUDE.md).
