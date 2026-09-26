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

The app runs as a **systemd service** (`pdfclaudeassistant`, user `pdfclaude`)
listening only on `127.0.0.1:PORT`, behind the Caddy that already runs on the
host. It uses its own Node 22 under `/opt/pdfclaudeassistant/runtime`, so the
system Node of other services is left alone.

Requirements on the VPS: Ubuntu/Debian with Caddy, `curl` and `openssl`. The
first deploy installs the rest (`ocrmypdf`, Tesseract `spa`/`eng`, Node 22).

### Deploying from your PC (`scripts/deploy.ps1`)

Deploys run from a Windows PC over SSH. The script packs the **committed** code
(`git archive HEAD`), copies it with `scp` and runs `scripts/deploy-remote.sh`
on the VPS, which:

1. builds the release there (pnpm install, web and server builds) and checks
   that the native modules load;
2. swaps it into `/opt/pdfclaudeassistant/app`, keeping the previous one until
   the new one passes `/api/health`, and **rolls back** if it does not;
3. keeps this app's own block in the shared `/etc/caddy/Caddyfile` (between
   `# >>> PDFCLAUDEASSISTANT BEGIN/END <<<` markers), validating it before
   reloading and restoring the backup if it does not validate.

It never touches `.env` or `data/` after creating them.

```powershell
$env:PCA_DEPLOY_HOST = 'root@<VPS_HOST>'      # required
$env:PCA_DOMAIN = 'http://<APP_DOMAIN>'       # http:// prefix: Cloudflare in Flexible mode
# optional: PCA_APP_PORT (only for the first .env, default 8004),
#           PCA_DEPLOY_DIR (default /opt/pdfclaudeassistant), PCA_SSH_KEY
.\scripts\deploy.ps1
```

It refuses to run with uncommitted changes (`-AllowDirty` deploys `HEAD`
anyway). Database migrations run automatically when the server starts.

### First-time setup

1. `.\scripts\deploy.ps1`: installs everything, creates the `pdfclaude` user,
   `/opt/pdfclaudeassistant/.env` (with a random `SESSION_SECRET`) and `data/`,
   and publishes the Caddy block. It stops before starting the app because
   there is no login password yet.
2. `.\scripts\deploy.ps1 -SetPassword`: asks for the password on your PC and
   stores its argon2 hash in `.env` (the password travels over SSH stdin and is
   never written to disk). This starts the app.
3. Connect Claude (next section): run `claude setup-token` on your PC, then
   `.\scripts\deploy.ps1 -SetClaudeToken` and paste the token.
4. Open `https://<APP_DOMAIN>`, log in and check **Ajustes → Conexión con
   Claude**: it should say _Conectado con tu suscripción_.

Other settings (`CLAUDE_MODEL`, `MAX_UPLOAD_MB`, `OCR_LANGS`) are edited in
`/opt/pdfclaudeassistant/.env`, followed by `systemctl restart pdfclaudeassistant`.

### Backups

`cd /opt/pdfclaudeassistant/app && runuser -u pdfclaude -- env DATA_DIR=/opt/pdfclaudeassistant/data ../runtime/node/bin/node --env-file=../.env dist/backup.js`
writes `data/backups/pdfclaudeassistant-backup-YYYY-MM-DD.tar.gz` (database
snapshot, PDFs and covers; the Claude session is left out). **Ajustes** also has
a download button. A daily backup at 04:00 (`crontab -e` as root):

```cron
0 4 * * * cd /opt/pdfclaudeassistant/app && runuser -u pdfclaude -- env DATA_DIR=/opt/pdfclaudeassistant/data ../runtime/node/bin/node --env-file=../.env dist/backup.js >> /var/log/pdfclaudeassistant-backup.log 2>&1
```

Copy `data/backups/` off the VPS from time to time and prune old archives.

### Operating

- Logs: `journalctl -u pdfclaudeassistant -f` (lines prefixed
  `[PdfClaudeAssistant]`).
- Restart: `systemctl restart pdfclaudeassistant`. Deployed revision:
  `cat /opt/pdfclaudeassistant/app/REVISION`.
- Everything that matters lives in `/opt/pdfclaudeassistant/data` (SQLite, PDFs,
  covers, Claude session). Deploys keep it; never delete it.

### Alternative: Docker

`docker/server.Dockerfile` and `docker-compose.yml` still work on a host with
Docker: the container publishes only `127.0.0.1:${APP_PORT}`, and
`docker compose --profile caddy up -d` adds a bundled Caddy for hosts without a
proxy (`DOMAIN` in `.env`). Create `.env` from `.env.example`; the hash comes from
`docker compose run --rm --no-deps server node dist/hash-password.js 'password'`.

## Connecting Claude to your subscription

The server uses a long-lived subscription token. It stays on the server (in
`.env`) and never reaches the browser.

1. On any machine with Claude Code installed, run `claude setup-token` and sign
   in with your Claude account in the browser window it opens.
2. From your PC, store the token it prints on the VPS (it restarts the app):
   ```powershell
   .\scripts\deploy.ps1 -SetClaudeToken
   ```

With the Docker alternative, put it in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=...`
and run `docker compose up -d`; there you can also log in interactively with
`docker compose exec server claude` → `/login` (the session is kept in
`data/claude-home`, which downloadable backups leave out).

### When the session expires or you hit a limit

**Ajustes → Conexión con Claude** shows one of: connected, session expired, usage
limit reached. For an expired session create a new token and run
`-SetClaudeToken` again. Usage limits reset on your subscription's schedule.

## Updating

Commit, then run `.\scripts\deploy.ps1` from your PC (see above). Database
migrations run automatically on startup; a release that fails its health check
is rolled back.

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
