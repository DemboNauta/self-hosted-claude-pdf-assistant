# PdfClaudeAssistant — working notes for Claude Code

Self-hosted study assistant: PDF viewer + Claude (via the owner's Claude
subscription through the Claude Agent SDK, never an API key) with annotations,
memory and spaced repetition. Single user. `SPEC.md` is the source of truth.
**Start every session by reading `docs/README.md`** (reading order; `docs/HANDOFF.md`
has owner preferences and next steps) and update `docs/HANDOFF.md` at the end.

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

Phases 0–3 of SPEC §13 are implemented and tested (unit + Playwright with a fake
Claude). Phase 0 is not yet accepted on the VPS, and the deployment milestone is
in progress. Per-feature status: `docs/FEATURES.md`. Next steps:
`docs/HANDOFF.md` and `docs/DEPLOYMENT.md`.

## Where to look

- `docs/README.md`: reading order for a new session.
- `docs/DECISIONS.md`: owner decisions and provisional choices. Open decisions
  4 (semantic search: not done), 5 (voice: Web Speech API) and 7 (no usage
  counter) were settled provisionally by Claude.
- `docs/ARCHITECTURE.md`, `docs/CLAUDE_INTEGRATION.md`, `docs/API.md`,
  `docs/DATA_MODEL.md`: references.
- `docs/DEVELOPMENT.md`: Windows quirks (`corepack pnpm`, Playwright pnpm shim,
  preview-pane launch configs, LF endings) and gotchas.

## Deployment (summary)

- Deploys run from the owner's Windows PC over SSH with `scripts/deploy.ps1`
  (to be written: host from an env var, code copied with scp, never touching the
  server's `.env` or `data/`).
- The VPS runs its own **Caddy outside Docker**. The app container serves web,
  API and WS on `127.0.0.1:${APP_PORT}` only; the bundled Caddy is an optional
  compose profile.
- **Never commit the domain, the VPS IP or any host detail.**
- The domain is on Cloudflare (proxied). Uploads are chunked, so there is no
  100 MB problem.

## Notes

- Per-turn context (current page, selection, mode, memory) must go in the user
  message, not the system prompt: the SDK snapshots the system prompt on the
  first request and reuses it on resume.
- Never read, copy or modify the owner's local `data/` (his real PDFs). Test
  with the e2e server or a temp `DATA_DIR`.
