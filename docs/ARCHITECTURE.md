# Architecture

pnpm monorepo, strict TypeScript everywhere, Node 22.

```
apps/server     Fastify API + WebSocket + Claude Agent SDK + ingestion (esbuild bundle)
apps/web        React 19 + Vite + Tailwind v4 + TanStack Query + Zustand + React Router
packages/shared Zod schemas and DTO/event types shared by both (TS sources, no build)
docker/         server.Dockerfile (web + server in one image), caddy.Dockerfile (optional)
scripts/        deploy.ps1 (runs on the PC) + deploy-remote.sh (runs on the VPS)
deploy/         systemd unit and a reference Caddy block (see DEPLOYMENT.md)
docs/           these notes
```

## Server (`apps/server/src`)

**Multi-user.** Every row belongs to a user (`user_id`). Services are classes
bound to one user id and built per request by `servicesFactory` (`services/scope.ts`):
routes call `svc(req).library…`, the chat socket and Claude's tools use the
services of the turn's owner. A foreign id is simply not found. Server-wide pieces
stay unscoped: `UserService` (accounts, invitations, encrypted Claude tokens),
`SessionStore`, the ingest queue, upload chunks (each upload's metadata records its
owner) and the trash purge. `claude/credentials.ts` decides whose Claude
subscription a request uses.

`main.ts` loads the config (`config.ts`, Zod-validated env), runs the API-key
guard (`auth-guard.ts`) and calls `buildApp()` (`app.ts`). `buildApp` wires
everything and is also what tests use, through `test/helpers.ts` `authedApp()`.

| Folder      | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth/`     | Username + password login (argon2), signed session cookie `pdfclaudeassistant_session`, sliding 90 days, bound to a user. An `onRequest` guard sets `req.user` and protects `/api/*` and `/ws/*` except login, session, sign-up and health; `/api/admin/*` needs the admin role. Also the account and admin routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `db/`       | `schema.ts` (Drizzle, SQLite via better-sqlite3), `client.ts` (opens the DB, runs migrations from `drizzle/` on boot, WAL, foreign keys on).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `routes/`   | Thin HTTP layer. Each route validates input with Zod via `validate.ts` `parse()`, which throws 400 `invalid_request`. `web.ts` serves the SPA when `WEB_DIR` is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `services/` | Business logic, synchronous SQLite. `library` (tree, CRUD, trash, positions, reading time), `uploads` (chunked uploads, URL import), `url-import` (SSRF-safe download), `search` (FTS5), `threads` (chat threads and messages; `documentQuestions` for the question marks), `annotations`, `anchoring` (quote → rects from stored text items), `export` (annotated PDF), `settings`, `memory`, `review` (flashcards + FSRS), `brief` (daily brief via Claude), `stats`, `backup`, `users` (accounts, invitations, per-user Claude token), `scope` (per-request services bound to one user), `secrets` (AES-256-GCM for stored tokens), `diagrams` (Claude's Mermaid schemas, source check), `focus` (study-timer blocks). `errors.ts` has `HttpError(status, code)`, which the app turns into `{ error: code }`. `ids.ts` makes 10-char base36 ids (short because Claude writes them in citations). |
| `ingest/`   | `service.ts`: sequential queue (resumes on boot), worker thread (`worker.ts` → `extract.ts` PDF.js legacy + @napi-rs/canvas for covers, page images and `renderMarkImage`, the marked area with the student's drawing), optional OCR (`ocr.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `claude/`   | See `CLAUDE_INTEGRATION.md`: `options.ts` (sandboxed SDK options), `status.ts` (connection probe, cached per user), `credentials.ts` (per-user token and config dir), `chat.ts` (turn runner), `prompt.ts`, `tools.ts` (in-process MCP tools), `errors.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Other entry points (bundled by `build.mjs`): `dist/main.js`,
`dist/ingest-worker.js`, `dist/hash-password.js`, `dist/backup.js`.
`scripts/e2e-server.ts` is a fake-Claude server for Playwright.
`scripts/generate-icons.ts` renders the PWA icons.

`AppDeps` in `app.ts` holds the test and e2e seams:

- `claudeQuery`: fake Agent SDK `query`.
- `claudeStatus`: status service with a fake query.
- `ocr`: OCR runner, or null.
- `allowPrivateUrls`: URL import from localhost.
- `loginAttemptsPerMinute`: higher login rate limit for e2e.

## Web (`apps/web/src`)

- `App.tsx`: routes. `components/AppShell.tsx`: sidebar on desktop, 5-item
  bottom bar on phones (`desktopOnly` items are hidden there). `Dialog`
  (native `<dialog>`), `Menu` (popover), `Page`.
- `lib/api.ts`: fetch wrapper that throws `ApiError(status, code)` and returns
  `undefined` for 204. `lib/queryClient.ts`: the shared TanStack client, usable
  outside React. `lib/theme.ts`: theme and dark-PDF preference (persisted).
- `i18n/es.ts`: **all UI text** lives here (`t.*`).
- `features/`:
  - `library/`: tree + grid, dnd (`dnd.ts` filters collisions and keyboard
    moves to "peers"), chunked upload manager (`uploads.ts`, XHR for progress),
    trash, URL import dialog.
  - `reader/`:
    - `ReaderPage`: layout, toolbar, side panels, chat dock, selection menu,
      shortcuts.
    - `PdfViewer`: virtualised layout from stored page sizes; zoom anchors are
      tied to their target scale (see gotchas in `DEVELOPMENT.md`).
    - `PdfPage`: canvas + PDF.js `TextLayer` + highlights. Its `underlay` slot
      sits under the text layer (annotations), `overlay` above it (notes,
      drawings, pointers).
    - `textMatch.ts`: finds quotes in the text layer, ignoring accents, case,
      spaces and quote style, and falls back to word prefixes.
    - `store.ts` (Zustand): current page, zoom, panels, navigation requests,
      flash, tools and filters.
    - `readingTimer.ts`, `shortcuts.tsx`, `SelectionMenu.tsx`,
      `PointerLayer.tsx`.
  - `chat/`:
    - `store.ts`: the single `/ws/chat` socket with reconnect, and the chat
      state for one scope (document, topic or subject).
    - `ChatPanel` (mode bar with the diagram scope, composer with the attached
      selection or drawing mark), `ChatDock` (desktop panel or mobile sheet),
      `Markdown` (citations become `cite:` links, then `CitationChip`;
      `[[diagram:ID]]` becomes a `DiagramEmbed`), `dictation.ts` (voice),
      `ScopeChatPage` (topic/subject chat).
    - `QuestionMarks`: margin badges on passages the student asked about, with
      the questions and answers (`GET /documents/:id/questions`).
  - `annotations/`:
    - `api.ts`: queries and undoable mutations.
    - `AnnotationLayer` (underlay, overlay, pen/eraser/note input, dragging
      sticky notes and drawings), `AnnotationPopover` (the note window:
      floating or phone sheet, resizable, movable, pinnable; `display` is saved
      on the server; `popoverSize.ts` remembers the default size per layout),
      `AnnotationsPanel`, `AnnotationTools` (floating toolbar with "Preguntar"
      for new drawings, undo shortcuts).
    - `mark.ts`: builds the drawing mark (area + text inside) sent to the chat.
    - `integrations.tsx`: selection-menu actions, the "Guardar" button on
      pointer marks, and refresh on the chat's `data_changed` events.
  - `diagrams/`: Mermaid loaded on demand and rendered in the app's colours
    (`mermaid.ts`), `DiagramView` (inline in the chat, full-screen viewer),
    `PanZoom` (free zoom and pan canvas), reader panel and `/diagrams` page.
  - `timer/`: study timer (`engine.ts` is pure and timestamp based, `store.ts`
    persists to localStorage and syncs tabs, floating widget, break screen).
  - `memory/`, `review/` (queue, rating, flashcard dialog, brief and stats
    hooks), `stats/`, `search/`, `home/`, `settings/`, `auth/`.

Cross-feature communication:

- Zustand stores (`useReader`, `useChat`, `useChatDock`).
- The chat socket's `subscribe()` (pointers, `data_changed` → query
  invalidation).
- Small window events (`pca:zoom`, `pca:citation`, `pca:focus-composer`).

## Request flow examples

- **Question about a selection:** `SelectionMenu` → `useChat.send()` → WS
  `user_message` → `ChatService.send()` stores the user message, starts the
  assistant message and runs `query()` with a per-turn MCP server. Stream
  deltas become `assistant_delta` events, tool calls become `tool_event`s
  (plus `pointer` / `data_changed`), and the turn ends with `assistant_done`.
  The client store updates the message list, and the markdown renders chips.
- **Question about a drawing:** "Preguntar" → `mark.ts` builds
  `context.mark` (page, area, drawing ids, text inside) → the server renders
  that area with the strokes (`renderMarkImage`) and sends it to Claude as an
  image block next to the text (`withImage` in `claude/chat.ts`).
- **Diagram:** "Esquema visual" mode (+ optional `context.pageRange`) → Claude
  calls `create_diagram` → `data_changed: diagrams` → the answer's
  `[[diagram:ID]]` renders the saved diagram.
- **Citation click:**
  - Same document: `useReader.goTo(page, quote)`, which sets `nav` and `flash`.
    `PdfViewer` scrolls; `PdfPage` finds the quote rects and scrolls them into
    view.
  - Other document: navigate to `/read/:id?page=N&q=quote`.
- **Upload:** `POST /api/uploads` → `PUT /api/uploads/:id?offset=` chunks →
  `POST /complete` → document row + `ingest.enqueue` → worker → pages + FTS.
  The UI polls `/api/library` while anything is processing.
