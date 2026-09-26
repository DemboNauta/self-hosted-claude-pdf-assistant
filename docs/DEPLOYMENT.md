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

## To do (next session)

1. **`scripts/deploy.ps1`** (PowerShell 5.1 compatible):
   - Parameters and env vars: `PCA_DEPLOY_HOST` (e.g. `root@<VPS_HOST>`,
     required), `PCA_DEPLOY_DIR` (default `/opt/pdfclaudeassistant`),
     `PCA_SSH_KEY` (default `$env:USERPROFILE\.ssh\id_ed25519`),
     `PCA_APP_PORT` (default 3000, used for the health check).
   - Steps:
     1. Fail if the working tree is dirty, or warn.
     2. `git archive --format=tar.gz -o $env:TEMP\pca.tgz HEAD`.
     3. `scp` it to `/tmp`.
     4. `ssh`:
        - `mkdir -p $DIR`;
        - extract into `$DIR` with `tar -xzf` **excluding** `.env` and `data`
          (they are not in the archive anyway: `.env` and `data/*` are
          gitignored);
        - `cd $DIR && docker compose up -d --build server`;
        - `docker image prune -f`.
     5. Poll `ssh … curl -fsS http://127.0.0.1:$PORT/api/health` for up to
        about 60 s.
     6. Print the result.
   - First run: if `$DIR/.env` is missing, stop with instructions (see the
     first-time setup below).
2. **`deploy/host-caddy.example`**: block to paste into the VPS Caddyfile:
   ```caddyfile
   <APP_DOMAIN> {
   	encode zstd gzip
   	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
   	reverse_proxy 127.0.0.1:3000
   }
   ```
   Then `caddy reload` / `systemctl reload caddy`. Caddy passes WebSockets
   through and has no body limit by default.
   - With Cloudflare proxied, the Cloudflare SSL mode should be "Full (strict)"
     (Caddy gets a real certificate), or use a Cloudflare origin certificate.
     Confirm with the owner.
3. **README**: replace "Deploying on a VPS" (it still describes bundled Caddy on
   80/443) with:
   - the host-Caddy flow;
   - the optional bundled-Caddy profile;
   - `deploy.ps1` usage;
   - the backup cron line, e.g.
     `0 4 * * * cd /opt/pdfclaudeassistant && docker compose exec -T server node dist/backup.js`.
   - Keep the "Connecting Claude" section (token or interactive login).
4. **CI** (`.github/workflows/ci.yml`, `docker` job): keep building
   `docker/server.Dockerfile` (it now includes the web).
   `docker/caddy.Dockerfile` is tiny now; building it is optional.
5. Update `CLAUDE.md` "Status" and "Deployment" to match.

## First-time setup on the VPS (for the README / to guide the owner)

```bash
# Docker + compose plugin installed; then:
mkdir -p /opt/pdfclaudeassistant && cd /opt/pdfclaudeassistant
# (first deploy.ps1 run copies the code here)
cp .env.example .env
mkdir -p data/claude-home && chown -R 1000:1000 data
docker compose build server
docker compose run --rm --no-deps server node dist/hash-password.js '<password>'
#   -> paste APP_PASSWORD_HASH='…' (single quotes) into .env
openssl rand -hex 32            # -> SESSION_SECRET
# CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token` on any machine
# APP_PORT: a free loopback port (other services already use some)
docker compose up -d server
curl -fsS http://127.0.0.1:${APP_PORT:-3000}/api/health
```

Then add the host Caddy block, reload Caddy and open `https://<APP_DOMAIN>`.

**Phase 0 acceptance:**

- HTTPS login works.
- Settings → Conexión con Claude says "Conectado con tu suscripción".
- With `ANTHROPIC_…_KEY` set in `.env`, the server refuses to start. Remove it
  afterwards.

## Operating notes

- Logs: `docker compose logs -f server` (prefix `[PdfClaudeAssistant]`).
- Renewing Claude: new token in `.env`, then `docker compose up -d`; or
  `docker compose exec server claude` → `/login`.
- Data lives in `./data` (SQLite, PDFs, covers, Claude session). Back it up;
  never delete it on deploy.
