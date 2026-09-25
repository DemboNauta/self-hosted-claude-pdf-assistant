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

- **Phase 0 — skeleton: implemented.** Monorepo, Fastify server with login,
  SQLite + Drizzle migrations, API-key guard + filtered agent env,
  `GET /api/claude/status`, React shell with Settings → Conexión con Claude,
  Docker Compose + Caddy, CI. Acceptance on the real VPS (HTTPS + subscription
  status) is pending the owner's deployment.
- Deviations: API routes live under `/api` (Caddy routes `/api/*` and `/ws/*`
  to the server); the web build is served by the `caddy` service, so there is
  no separate `web` container.
- Next: **Phase 1 — read and ask.**

## Notes

- Per-turn context (current page, selection, mode) must go in the user message,
  not the system prompt: the SDK snapshots the system prompt on the first
  request and reuses it on resume.
- The Docker image cannot be fully built inside the Claude Code sandbox (apt and
  prebuilt binaries are blocked); CI's `docker` job is the source of truth.
