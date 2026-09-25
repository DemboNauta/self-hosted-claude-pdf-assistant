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

Requirements: Docker with Compose, a domain whose DNS points at the VPS, and ports
80/443 open.

```bash
git clone https://github.com/DemboNauta/self-hosted-claude-pdf-assistant.git
cd self-hosted-claude-pdf-assistant
cp .env.example .env

# The container runs as uid 1000; give it the data directory.
mkdir -p data/claude-home && sudo chown -R 1000:1000 data

docker compose build
```

Fill in `.env`:

| Variable                  | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| `DOMAIN`                  | Your domain, e.g. `estudio.example.com`. Caddy gets the HTTPS cert.       |
| `APP_PASSWORD_HASH`       | Output of the command below, **inside single quotes** (the hash has `$`). |
| `SESSION_SECRET`          | `openssl rand -hex 32`                                                    |
| `CLAUDE_CODE_OAUTH_TOKEN` | Subscription token (method 1 below). Leave empty for method 2.            |
| `CLAUDE_MODEL`            | Optional model alias/ID. Empty uses Claude Code's default.                |
| `MAX_UPLOAD_MB`           | `0` = no limit.                                                           |
| `OCR_LANGS`               | Tesseract languages, default `spa+eng`.                                   |

Generate the password hash:

```bash
docker compose run --rm --no-deps server node dist/hash-password.js 'your password'
# -> APP_PASSWORD_HASH='$argon2id$v=19$...'   paste this line into .env
```

Then connect Claude (next section) and start:

```bash
docker compose up -d
```

Open `https://your-domain`, log in, and go to **Ajustes → Conexión con Claude**:
it should say _Conectado con tu suscripción_.

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

```bash
git pull
docker compose build
docker compose up -d
```

Database migrations run automatically on startup.

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
