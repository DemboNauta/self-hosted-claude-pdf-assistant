# Handoff — context for the next Claude Code session

Read this, then `CLAUDE.md` (conventions + decisions) and `SPEC.md` (source of
truth). This file captures what the previous session learned while talking with
the owner (Edgar), so the next session can continue as if it were the same
conversation. Keep it updated at the end of each session.

## Who and how

- Single owner, Spanish speaker. Talk to him in Spanish; code, comments,
  commits and docs in English.
- **Ask before assuming** anything about product, UX or data handling. He
  explicitly asked for this. Technology choices are yours.
- Work directly on `main`, one commit per milestone, Conventional Commits in
  English with feature IDs in the body when relevant.
- Commit author must be `Edgar <edgarmila_10@outlook.com>`. **Never** add
  `Co-Authored-By`, session links or anything attributing commits to Claude.
  History was already rewritten (force-push) so no commit is authored by Claude.
- **Never put the domain, VPS IP or any VPS detail in the repository** (files,
  commits, messages). They belong only in the VPS `.env`, the VPS Caddyfile and
  environment variables on the owner's PC. Ask him for them when needed.
- The previous session ran in a cloud sandbox with no SSH egress, so it could
  not deploy. The next session runs on the owner's Windows PC and can use his
  SSH key.

## Decisions taken (beyond SPEC)

| Topic                            | Decision                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Visual style (#1)                | Minimalist, typographic (Inter for UI, Source Serif 4 for headings, neutral warm greys)                                                  |
| Highlight colours (#2)           | Yellow = important, green = definition, blue = example, red = don't understand, purple = review; Claude uses orange. Configurable later. |
| Claude's answer language (#3)    | The language of the user's question                                                                                                      |
| Max PDF size (#6)                | No limit (`MAX_UPLOAD_MB=0`); uploads streamed to disk                                                                                   |
| Deleting subject/topic with PDFs | PDFs go to the trash (30 days); restore asks for a destination topic. A minimal trash view ships in Phase 1.                             |
| Phase order                      | Phase 1 started before Phase 0 was accepted on the VPS (owner's call)                                                                    |
| Deployment                       | Owner prefers deploying over SSH from his PC with a script, like his other project's `deploy.ps1`                                        |

## Open questions — ask before implementing

1. **Cloudflare upload limit.** The domain is on Cloudflare. Proxied (orange
   cloud) free plan rejects request bodies > 100 MB, which conflicts with
   "no size limit". Options: chunked uploads (previous session recommended
   this), DNS-only (grey cloud) for the subdomain, or cap at 100 MB. The owner
   dismissed the question without answering; ask again.
2. Whether he wants to see the app running locally before or after the VPS
   deployment (he mentioned both).
3. Still open from SPEC §14: #4 semantic search, #5 voice backend, #7 usage
   counter (not needed until later phases).

## Deployment facts (VPS)

- The VPS already runs other services (e.g. a `garmin-api` systemd service on
  port 8003) and **its own Caddy outside Docker on 80/443**.
- **Docker is not installed** on the VPS yet; he agreed to install it.
- Access: `ssh -i %USERPROFILE%\.ssh\id_ed25519 root@<IP>` (host from an env var;
  ask him for it). His other project's deploy script copies code with scp,
  never touches `.env` or `data/`, restarts, then curls a health endpoint.
- Required changes (not done yet):
  - Server container must also serve the web build (SPA fallback) and publish
    only `127.0.0.1:<port>`; the bundled Caddy becomes an optional compose
    profile.
  - Add a block for the app's subdomain to the VPS Caddyfile:
    `reverse_proxy 127.0.0.1:<port>` (WebSockets pass through).
  - `scripts/deploy.ps1`: host from an env var, copy code (e.g. `git archive`)
    with scp, `docker compose up -d --build`, check `/api/health`.
  - First-time setup on the VPS: `.env` (password hash via
    `docker compose run --rm --no-deps server node dist/hash-password.js '<pw>'`,
    `SESSION_SECRET`, `DOMAIN`, `CLAUDE_CODE_OAUTH_TOKEN` from
    `claude setup-token`), `data/` owned by uid 1000.
- Phase 0 acceptance: HTTPS login works, Settings → Conexión con Claude says
  "Conectado con tu suscripción", and setting `ANTHROPIC_API_KEY` makes the
  server refuse to start.

## What exists (code map)

- `apps/server` (Fastify, TypeScript, bundled with esbuild via `build.mjs`)
  - `src/auth-guard.ts`: refuses to start with an Anthropic API key; builds the
    filtered env for Claude Code.
  - `src/claude/`: sandboxed Agent SDK options (`tools: []`, `dontAsk`,
    `settingSources: []`, `strictMcpConfig`, isolated cwd), status probe with
    10-min cache, error classification.
  - `src/auth/`: argon2 password login, sliding 90-day session cookie, rate
    limit; guard protects `/api/*` and `/ws/*`.
  - `src/db/`: Drizzle schema + migrations (`drizzle/`, incl. a custom FTS5
    migration with triggers), applied on boot.
  - `src/services/library.ts`: subjects/topics/documents, reorder, move, trash
    (purged after 30 days), reading position + viewed pages → progress.
  - `src/ingest/`: queue + worker thread using PDF.js (legacy build) and
    `@napi-rs/canvas`: per-page text, normalised text items
    `[str, x, y, w, h]` (0–1, top-left origin), page sizes, outline, WebP cover.
  - `src/routes/`: `/api/library`, subjects, topics, documents (detail, file,
    cover, position, reorder), trash, `/api/documents/upload?topicId=`.
- `apps/web` (Vite + React + Tailwind v4 + TanStack Query + Zustand + React
  Router): login, app shell (sidebar desktop / bottom bar mobile), home
  placeholder, settings (theme + Claude connection). UI strings in
  `src/i18n/es.ts`. Playwright e2e for Phase 0 with a fake Claude
  (`apps/server/scripts/e2e-server.ts`).
- `packages/shared`: Zod schemas + DTOs shared by both apps.
- CI (`.github/workflows/ci.yml`): lint, format check, typecheck, unit tests,
  e2e, Docker builds of both images.

## Next steps (Phase 1, in order)

1. Library UI (F-LIB-01..03): tree, drag & drop reorder, upload dropzone with
   progress, cards with cover/progress/last access, processing status polling,
   minimal trash view.
2. PDF viewer (F-VIS-01/02, F-LIB-04): PDF.js in the browser, virtualised
   (visible pages ± 2, layout from stored page sizes), text layer, zoom/fit,
   thumbnails, outline, in-document search, resume position.
3. Annotations (F-ANN-01/02/05/07): highlights with the colour palette, notes,
   layer toggle and filters, side panel. Anchors in normalised page space.
4. Claude chat backend (F-CHAT-01/04/07): WS `/ws/chat`, threads/messages
   tables, one Claude session per thread resumed via `resume`, in-process MCP
   server with `get_document_info`, `get_pages` (≤ 10 pages), `search_library`
   (doc scope), citations `[[cite:docId:page|"quote"]]`, errors mapped to
   `rate_limited` / `auth_expired` / `internal`.
5. Chat UI (F-CHAT-01/02/05, F-VIS-03): side panel / mobile bottom sheet,
   streaming Markdown + KaTeX, selection menu, citation chips that jump to the
   page and briefly highlight the quote.
6. Phase 1 Playwright acceptance test (fake Claude) and update `CLAUDE.md` +
   this file.

## Gotchas learned

- Put per-turn context (current page, selection, mode) in the user message,
  not the system prompt: the SDK snapshots the system prompt on the first
  request and reuses it on resume.
- `typescript-eslint` does not support TypeScript 7 yet → TS pinned to ~6.0.
- PDF.js v6 in Node: no `isEvalSupported`, destroy via
  `pdf.loadingTask.destroy()`; pass `standardFontDataUrl`, `cMapUrl`, `wasmUrl`
  as filesystem paths.
- Dev worker threads: Node's native type stripping bypasses tsx's `.js` → `.ts`
  resolution, so `src/ingest/service.ts` boots the worker through an eval'd
  bootstrap that registers `tsx/esm/api`. Don't add a `createRequire` banner
  to esbuild (it collides with bundled code).
- Local Playwright with a preinstalled Chromium:
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium pnpm e2e`.
- `.env` values containing `$` (the argon2 hash) must be single-quoted.
