# Development on the owner's PC (Windows 11)

## Tooling quirks

- Node 22. **`pnpm` is only available as `corepack pnpm`.** Root scripts that
  call `pnpm` internally (`pnpm test`, `pnpm dev`, `pnpm e2e`) fail with "pnpm no
  se reconoce". Run per package instead:
  - `corepack pnpm --filter @pdfclaudeassistant/server test` (also `typecheck`
    and `build`);
  - `corepack pnpm --filter @pdfclaudeassistant/web test` (also `typecheck` and
    `build`);
  - `corepack pnpm lint` and `corepack pnpm exec prettier --check apps packages`
    work from the root.
- For Playwright, put a `pnpm` shim on PATH (the scratchpad `bin/pnpm.cmd`
  contains `@corepack pnpm %*`), then run `npx playwright test` in `apps/web`,
  e.g. from PowerShell:
  `$env:Path = "<dir-with-pnpm.cmd>;$env:Path"; npx playwright test`.
  Chromium is installed (`npx playwright install chromium`).
- The Bash tool is Git Bash. Python is available and handy for multi-line edits,
  but heredocs mangle `\n`, `\d`, `­` escapes. Prefer the Edit/Write tools
  for code containing escapes, then check with `grep`.
- `git config core.autocrlf false` is set locally. The repo is LF (Prettier
  enforces it). If `git status` shows files as modified without a diff, run
  `git update-index --refresh`.
- Docker is **not** installed on the PC, so the image is built only in CI (and
  later on the VPS).

## Running the app locally

`.claude/launch.json` (uncommitted) has these configurations for the preview
pane:

| Name         | What                                                                                                                 | Port |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ---- |
| `server`     | `tsx --env-file=../../.env src/main.ts` (**no watch**: `tsx watch` hung from the pane; restart after server changes) | 3000 |
| `web`        | Vite dev server, proxies `/api` and `/ws` to :3000                                                                   | 5173 |
| `e2e-server` | `scripts/e2e-server.ts`: fresh temp data dir, fake Claude, password `e2e-password`                                   | 3100 |
| `e2e-web`    | Vite on 5174 proxying to :3100                                                                                       | 5174 |

- The owner's `.env` (gitignored) holds these values:
  - a generated local password, as a comment on line 2 (**never print it in
    chat**);
  - `DATA_DIR=../../data`, which is **his real data: don't create, modify or
    copy anything in it**;
  - his `CLAUDE_CODE_OAUTH_TOKEN`.
- For manual UI checks, use `e2e-server` + `e2e-web` and upload generated PDFs
  through the API. `apps/server/test/fixtures/pdf.ts` `makePdf` or
  `apps/web/e2e/helpers.ts` `tinyPdf` can generate them.
- Playwright starts its own servers on 3100/5174 (`reuseExistingServer: false`),
  so stop the `e2e-*` preview servers before running it.
- In development the web registers no service worker, which only runs in
  production builds.

## Tests

- **Server** (`apps/server/test`, vitest, 30 s timeouts because the ingest worker
  boots tsx):
  - `authedApp(overrides, deps)` builds the app with a logged-in cookie.
  - `seedDocument(app, headers, pages)` creates subject → topic → PDF and waits
    for ingestion.
  - `tempDataDir(prefix)` gives a fresh data dir.
  - Fake Claude: pass `claudeQuery`.
- **Web unit** (`apps/web/src/**/*.test.ts`): citations and relative time.
- **E2E** (`apps/web/e2e`, desktop + Pixel 7 projects): one spec per area.
  `helpers.ts` has `login`, `seedDocument`, `selectInPdf` (programmatic text
  selection in the text layer) and `openPanel` (toolbar icon or the phone
  "Paneles" menu).
  - Desktop and mobile share one server, so give names per project
    (`${info.project.name}`).
- Commit only after `lint`, `typecheck`, the server tests and the e2e suite
  pass. Lint errors are not caught by the commit itself.

## Gotchas learned

- **PDF.js v6 (Node):** pass `standardFontDataUrl`, `cMapUrl` and `wasmUrl` as
  paths with a trailing `/` and forward slashes (Windows). Destroy with
  `pdf.loadingTask.destroy()`.
- **Dev worker threads:** `src/ingest/service.ts` boots the TS worker through an
  eval'd bootstrap that registers `tsx/esm/api`. Don't add a `createRequire`
  banner to esbuild.
- **Text layer:** copy of PDF.js CSS in `features/reader/textLayer.css`. The page
  element sets `--total-scale-factor` and `--scale-round-x/y`. Highlights go in
  `underlay` (under the text) so selection keeps working.
- **Zoom anchors** carry the scale they target. An anchor captured for a no-op
  scale change used to fire later and jump pages (fixed; keep it that way).
- **dnd-kit in a nested tree:** collisions and keyboard coordinates are filtered
  to peers (`features/library/dnd.ts`). Otherwise arrow keys stop on nested
  topics. The keyboard getter needs a map exposing both `getEnabled()` and
  `get()`.
- **Zustand v5:** selectors returning new arrays need `useShallow`, or React
  loops.
- **React Hooks lint (v7):** no synchronous `setState` in effects (derive with
  `useMemo`, or initialise child components from props) and no `Date.now()`
  during render (keep it in class instances or effects).
- **TanStack mutations:** `onSettled` returns the invalidation promise, so
  per-call `onSuccess` (e.g. navigating to a new topic) sees fresh data.
- **Chat socket:** errors without `messageId` end an exchange in tests (see
  `test/chat.test.ts` `ask()`).
- **drizzle-kit:** `ALTER TABLE ADD COLUMN … REFERENCES` omits `ON DELETE`; add
  it by hand. Correlated subqueries: write `threads.id` literally inside `sql`
  (the interpolated column rendered without its table).
- **`.env` values containing `$`** (the argon2 hash) must be single-quoted.
- **pdf-lib export** saves with `useObjectStreams: false`, so the annotations
  are plain objects that readers (and the test) see.
- **tar backup:** the SQLite snapshot is written next to the data and renamed
  inside the archive (`onWriteEntry`). Never use symlinks to `pdfs/`: a
  recursive cleanup could follow them.
