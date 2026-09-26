# Deployment (VPS)

> Never write the domain, the VPS IP or any VPS detail into the repo. Use
> placeholders (`<APP_DOMAIN>`, `<VPS_HOST>`) and ask the owner for the real
> values; they go only in the VPS `.env`, the VPS Caddyfile and environment
> variables on his PC.

## Target setup (owner decision)

- The VPS already runs **its own Caddy outside Docker** on 80/443, plus other
  services of the owner. This app must not bind 80/443; pick a free loopback
  port for `APP_PORT` (ask the owner).
- One container, `pdfclaudeassistant-server`:
  - it serves the web app, API and WebSocket;
  - it is published only on `127.0.0.1:${APP_PORT:-3000}`;
  - the host Caddy reverse-proxies the app's subdomain to it (WebSockets pass
    through).
- The domain is on **Cloudflare (proxied)**. Uploads are chunked (32 MiB), so
  the free plan's 100 MB body limit is not a problem. WebSockets work through
  Cloudflare. Idle connections are kept alive by 30 s server pings.
- Docker is **not installed on the VPS yet**; the owner agreed to install it.
- Deploys are run from the owner's Windows PC over SSH with a PowerShell
  script, like his other project's `deploy.ps1`:
  - SSH key: `%USERPROFILE%\.ssh\id_ed25519`, user root, host from an env var.
  - Code is copied with scp; the script never touches the server's `.env` or
    `data/`.
  - It restarts and then checks a health endpoint.

## Done in the repo

- `docker/server.Dockerfile`:
  - It builds the web (`apps/web/dist` → `/app/public`) and the server bundle.
  - The runtime has `ocrmypdf` + tesseract spa/eng, `poppler-utils`, the Claude
    Code CLI (for interactive `/login`) and `tini`, and runs as `node`
    (uid 1000).
  - Env: `DATA_DIR=/data`, `WEB_DIR=/app/public`,
    `CLAUDE_CONFIG_DIR=/data/claude-home`. Healthcheck `/api/health`.
- `docker-compose.yml`:
  - `server` publishes `127.0.0.1:${APP_PORT:-3000}:3000` and mounts
    `./data:/data`.
  - `caddy` is optional (`--profile caddy`) for hosts without a proxy
    (`Caddyfile` → `reverse_proxy server:3000`).
- `.env.example`: `APP_PORT`, `DOMAIN` (bundled Caddy only),
  `APP_PASSWORD_HASH`, `SESSION_SECRET`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_MODEL`, `MAX_UPLOAD_MB`, `OCR_LANGS`.
- Backups:
  - `docker compose exec server node dist/backup.js` writes
    `data/backups/pdfclaudeassistant-backup-YYYY-MM-DD.tar.gz`.
  - Settings has a download button (`/api/backup`).
  - `claude-home/` is excluded.

## Deploy tooling (done 2026-09-26)

- `scripts/deploy.ps1` (PowerShell 5.1, ASCII only):
  - settings: `PCA_DEPLOY_HOST` (required), `PCA_DEPLOY_DIR` (default
    `/opt/pdfclaudeassistant`), `PCA_SSH_KEY` (default `~\.ssh\id_ed25519`);
  - refuses uncommitted tracked changes unless `-AllowDirty`;
  - `git archive HEAD` → `scp` to `/tmp` together with `scripts/deploy-remote.sh`
    (converted to LF) → `ssh … bash /tmp/pca-deploy-remote.sh <dir> <rev>`.
- `scripts/deploy-remote.sh` (runs on the VPS):
  - refuses a non-empty directory that is not this app (checks
    `name: pdfclaudeassistant` in `docker-compose.yml`);
  - unpacks aside, removes the old code, keeps `.env`, `data/` and
    `docker-compose.override.yml`, writes `REVISION`;
  - first deploy: creates `data/claude-home` owned by uid 1000; without `.env`
    it stops with exit code 3 and `deploy.ps1` prints the setup steps;
  - `docker compose build server && up -d server`, `docker image prune -f`,
    then polls `http://127.0.0.1:$APP_PORT/api/health` (APP_PORT read from
    `.env`) for 90 s and prints the logs on failure.
  - Tried locally with fake `docker`/`curl` (first run, redeploy keeping
    `.env`/`data`, refusal of a foreign directory). **Not yet run against the
    VPS.**
- `deploy/host-caddy.example`: block for the host Caddyfile (Cloudflare SSL mode
  "Full (strict)").
- README "Deploying on a VPS": host-Caddy flow, first-time setup, backups with
  the cron line, operating notes, optional bundled Caddy.
- The image build checks that the native modules (better-sqlite3, canvas,
  argon2) load, so CI catches a broken prebuilt binary. CI still builds both
  images (the caddy one is tiny).
- `.gitattributes` keeps everything LF (shell scripts included) on any checkout.

## Next: the first deploy (with the owner)

Needs from the owner (never commit them): the SSH host, a free loopback
`APP_PORT` on the VPS, the app's domain, and confirmation that Cloudflare's SSL
mode is "Full (strict)". Docker must be installed on the VPS.

Steps are in the README ("First-time setup"). Then Phase 0 acceptance:

- HTTPS login works.
- Settings → Conexión con Claude says "Conectado con tu suscripción".
- With `ANTHROPIC_API_KEY` set in `.env`, the server refuses to start. Remove it
  afterwards.

## Operating notes

- Logs: `docker compose logs -f server` (prefix `[PdfClaudeAssistant]`).
- Renewing Claude: new token in `.env`, then `docker compose up -d`; or
  `docker compose exec server claude` → `/login`.
- Data lives in `./data` (SQLite, PDFs, covers, Claude session). Back it up;
  never delete it on deploy.
