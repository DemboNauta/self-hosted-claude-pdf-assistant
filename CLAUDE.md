# PdfClaudeAssistant — working notes for Claude Code

Self-hosted study assistant: PDF viewer + Claude (via the owner's Claude
subscription through the Claude Agent SDK, never an API key) with annotations,
memory and spaced repetition. Single user. `SPEC.md` is the source of truth.

## Conventions (SPEC §15)

- **Naming:** internal/UI name `PdfClaudeAssistant`. Packages
  `@pdfclaudeassistant/{web,server,shared}`, Docker services/network
  `pdfclaudeassistant-*`, DB `pdfclaudeassistant.db`, log prefix
  `[PdfClaudeAssistant]`, cookie `pdfclaudeassistant_session`.
- **Language:** UI text in Spanish (centralised in `apps/web/src/i18n`); code,
  identifiers, comments, docs and commits in English.
- **Commits:** Conventional Commits in English with scope, e.g.
  `feat(reader): add thumbnail navigation`, referencing feature IDs
  (`F-ANN-01`) in the body. Commit on `main`, one commit per milestone.
- **No co-author or attribution trailers** in commits. Never list Claude as a
  co-author.
- Strict TypeScript everywhere; no `any` unless justified.
- Shared types (WS events, anchors, DTOs) live in `packages/shared`.
- Zod validation on every input (REST, WS, MCP tools).
- Tests: unit tests for services (FSRS, text anchoring, citation parsing) and
  at least one Playwright e2e test per phase acceptance criterion.
- Accessibility: keyboard navigable, AA contrast, `aria-label` on icons.
- Viewer virtualisation: render only visible pages ± 2.
- **No Anthropic API usage:** never add `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `@anthropic-ai/sdk` or calls to the Anthropic API
  host. Claude is reached only through `@anthropic-ai/claude-agent-sdk` with
  the subscription session. `apps/server/test/no-api-key.test.ts` enforces it.
- Ask before implementing anything marked **[DECISIÓN ABIERTA]** (SPEC §14).
- **Owner preference:** whenever something is unclear or the owner's opinion
  could matter (product behaviour, UX, data handling), ask before assuming.
  Technology choices are left to Claude's judgement.
- Commit author: `Edgar <edgarmila_10@outlook.com>` (set in local git config).

## Resolved open decisions (SPEC §14)

- **#1** Visual style: minimalist, typographic.
- **#2** Highlight colours: semantic set — yellow = important, green = definition,
  blue = example, red = don't understand, purple = review. Claude uses its own
  colour (orange). Configurable in Settings.
- **#3** Claude answers in the language of the user's question.
- **#6** No upload size limit (`MAX_UPLOAD_MB=0` = unlimited); uploads are streamed
  to disk, long books handled via per-page text + virtualised viewer.

Other owner decisions:

- Deleting a subject/topic that still has PDFs moves those PDFs to the trash
  (30 days); restoring asks for a destination topic. A minimal trash view ships
  in Phase 1 for this reason (full F-LIB-05 in Phase 3).
- Phase 1 started before the owner validated Phase 0 on the VPS (owner's call).

Still open: 4 (semantic search), 5 (voice backend), 7 (usage counter).

## Commands

- `pnpm install` — install workspace
- `pnpm dev` — server (:3000) + web (:5173, proxies API/WS)
- `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm e2e`
- `pnpm --filter @pdfclaudeassistant/server db:generate` — new migration

## Status

- **Phase 0 — skeleton: implemented, not yet accepted on the VPS.** Monorepo,
  Fastify server with login, SQLite + Drizzle migrations, API-key guard +
  filtered agent env, `GET /api/claude/status`, React shell with Settings →
  Conexión con Claude, Docker Compose + Caddy, CI (lint, format, typecheck,
  unit, e2e, Docker builds).
- Deviations: API routes live under `/api`; the web build is served by the
  `caddy` service (no separate `web` container) — this changes with the
  deployment work below.
- **Phase 1 — read and ask: in progress** (owner chose to start before
  accepting Phase 0).
  - Done: library API (subjects/topics/documents, reorder, move, trash,
    reading position) and ingestion (streamed upload, worker-thread PDF.js
    extraction with normalised text coordinates, page sizes, outline, cover,
    FTS5).
  - Remaining, in order: library UI (F-LIB-01..03), PDF viewer (F-VIS-01/02,
    F-LIB-04), annotations (F-ANN-01/02/05/07), Claude chat backend (WS
    `/ws/chat`, MCP tools `get_document_info`, `get_pages`, `search_library`,
    citations `[[cite:docId:page|"quote"]]`), chat UI with selection menu and
    citation jumps (F-CHAT-01/02/04/05/07, F-VIS-03), Phase 1 e2e test.

## Deployment (pending, owner decisions)

- The owner runs deploys from their Windows PC over SSH (same approach as
  their other project's `deploy.ps1`: host read from an environment variable,
  code copied with scp, never touching the server's `.env` or `data/`).
- The VPS already runs its own **Caddy outside Docker** on 80/443, so this app
  must not start its own Caddy there: the server container should also serve
  the web build and listen only on `127.0.0.1:<port>`; the host Caddy
  reverse-proxies the app's subdomain to it (WebSockets included). Keep the
  bundled Caddy as an optional compose profile.
- Docker is not installed on the VPS yet; the owner will install it.
- **Never commit the domain, the VPS IP or any host detail**: they live only in
  the VPS `.env`, the host Caddyfile and local environment variables.
- **Open question:** the domain is on Cloudflare. If proxied (orange cloud),
  the free plan rejects request bodies over 100 MB, which conflicts with
  decision #6 (no upload limit). Options: chunked uploads (recommended), DNS
  only (grey cloud), or cap at 100 MB. Ask the owner before implementing.

## Notes

- Per-turn context (current page, selection, mode) must go in the user message,
  not the system prompt: the SDK snapshots the system prompt on the first
  request and reuses it on resume.
- Dev workers: `src/ingest/service.ts` boots the TypeScript worker through a
  tiny eval'd bootstrap that registers tsx (Node's native type stripping
  otherwise skips `.js` → `.ts` resolution). The bundle uses
  `dist/ingest-worker.js`. Do not add a `createRequire` banner to esbuild.
- The previous cloud session could not build the full Docker image (apt and
  prebuilt binaries blocked there) nor reach the VPS; CI's `docker` job builds
  both images.
