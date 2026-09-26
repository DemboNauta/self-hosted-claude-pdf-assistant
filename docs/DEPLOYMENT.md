# Deployment (VPS)

> Never write the domain, the VPS IP or any VPS detail into the repo. Use
> placeholders (`<APP_DOMAIN>`, `<VPS_HOST>`). The real values live only in
> environment variables on the owner's PC and on the VPS. The VPS is the same
> one as the owner's `garmin-ia` project (its host is in `~/.ssh/known_hosts`;
> ask the owner which entry if unsure).

## How it runs (owner decision, 2026-09-26)

The VPS (Ubuntu 24.04, 2 CPU, 3.7 GB RAM) hosts several of the owner's apps as
**systemd services behind one shared Caddy**, without Docker (the `garmin-ia`
docs advise against Docker there: its iptables rules bypass `ufw`). This app
follows the same pattern:

- Service `pdfclaudeassistant`, user `pdfclaude` (system user, no shell), unit
  from `deploy/pdfclaudeassistant.service` with hardening (`ProtectSystem`,
  `ProtectHome`, `NoNewPrivileges`, `MemoryMax=1500M`).
- Everything under `/opt/pdfclaudeassistant`:
  - `runtime/node` → a private Node 22 (the system Node 20 belongs to other
    apps), plus `runtime/corepack`;
  - `app/` the current release (`REVISION` inside), `app.prev/` only during a
    deploy;
  - `.env` (`root:pdfclaude 640`), `data/` (`pdfclaude`, 750).
- Listens on `127.0.0.1:8004` (`PORT` in `.env`). Ports already taken on the
  VPS: 3000, 3001, 3350, 8002, 8003, 8080 among others.
- Caddy: own block between `# >>> PDFCLAUDEASSISTANT BEGIN/END <<<` markers in
  `/etc/caddy/Caddyfile`, like `GARMIN` and `QUERIO`. The domain is on
  Cloudflare in **Flexible** mode like the owner's other subdomains of the same
  domain, so the site address has the `http://` prefix.
- OCR packages (`ocrmypdf`, `tesseract-ocr-spa/eng`) are installed system-wide
  by the first deploy.
- Docker (`docker/`, `docker-compose.yml`) stays in the repo as an alternative
  for other hosts.

## Deploy tooling

- `scripts/deploy.ps1` (PowerShell 5.1, ASCII only):
  - settings: `PCA_DEPLOY_HOST` (required), `PCA_DOMAIN`, `PCA_APP_PORT`
    (first `.env` only), `PCA_DEPLOY_DIR`, `PCA_SSH_KEY`;
  - deploy: refuses uncommitted tracked changes unless `-AllowDirty`;
    `git archive HEAD` → `scp` with `scripts/deploy-remote.sh` (as LF) → `ssh`;
  - `-SetPassword` / `-SetClaudeToken`: read the secret with
    `Read-Host -AsSecureString` and send it over SSH **stdin**.
- `scripts/deploy-remote.sh <command> <dir> …` (as root on the VPS):
  - `deploy`: ensure user, packages, Node and `.env` (random `SESSION_SECRET`),
    build in `build/` (pnpm install, web + server builds, `pnpm deploy --prod`),
    native-module smoke test, install/refresh the unit, swap releases, Caddy
    block (only rewritten when it changes; validated; backup restored on
    failure), restart, health check on `/api/health`, rollback on failure.
    Exit 3 when `APP_PASSWORD_HASH` is still empty (installed, not started).
  - `set-password` (stdin → `dist/hash-password.js` → `.env`) and
    `set-claude-token` (stdin → `.env`); both restart the service.
- Gotchas met on the first run:
  - PowerShell 5.1 turns redirected native stderr into errors: `Invoke-Remote`
    sets `ErrorActionPreference = 'Continue'` and relies on exit codes.
  - A `[string]` parameter defaulting to `$null` becomes `''`.

## Status

- 2026-09-26: first deploy done: release built and installed, unit enabled,
  Caddy block live (the site answered 502 until the app starts). Waiting for
  the owner to run `-SetPassword` and `-SetClaudeToken`.
- Then Phase 0 acceptance:
  - HTTPS login works.
  - Settings → Conexión con Claude says "Conectado con tu suscripción".
  - With `ANTHROPIC_API_KEY` in `.env`, the service refuses to start (check
    `journalctl -u pdfclaudeassistant`). Remove it afterwards.
- To do after that: add the backup cron line from the README.

## Operating notes

- Logs: `journalctl -u pdfclaudeassistant -f` (prefix `[PdfClaudeAssistant]`).
- Renewing Claude: `claude setup-token` on the PC, then
  `.\scripts\deploy.ps1 -SetClaudeToken`.
- Data lives in `/opt/pdfclaudeassistant/data` (SQLite, PDFs, covers, Claude
  session). Back it up; never delete it.
