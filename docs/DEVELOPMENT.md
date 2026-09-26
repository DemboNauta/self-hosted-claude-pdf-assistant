# Development on the owner's PC (Windows 11)

## Tooling quirks

- **Voice mode locally:** download `piper_windows_amd64.zip` (rhasspy/piper
  release 2023.11.14-2) and the two voices listed in `scripts/deploy-remote.sh`
  into one folder (`piper.exe`, `voices/*.onnx(.json)`) and set `PIPER_DIR` to it
  in `.env`. Without it voice mode uses the browser's voices. The first sentence
  after a start takes a few seconds on Windows (model load); the web warms it up
  when voice mode starts.

- **Node:** the PC's nvm default is Node 24, which is what works locally. With
  Node 22.13 the prebuilt `better-sqlite3` binary segfaults on load, and its
  old corepack fails with "Cannot find matching keyid". `better-sqlite3` v13
  ships prebuilt binaries, so it is not in `onlyBuiltDependencies` (building it
  would need Visual Studio). The Docker image still uses `node:22` (latest 22.x).
- **Fresh clone:** set `git config core.autocrlf false` _before_ editing (a clone
  with `true` checks out CRLF files); re-checkout with
  `git rm -rq --cached . && git reset -q --hard` if it already happened. Then
  `corepack pnpm install`, create `.env` (see below) and
  `npx playwright install chromium` in `apps/web`.
- **`pnpm` is only available as `corepack pnpm`.** Root scripts that
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
- The Bash tool is Git Bash. Python is **not** installed. Heredocs mangle
  backslashes (`\n`, `\d`, `\(`) and non-ASCII text (`ñ`, `·`) piped to `node -`.
  Prefer the Edit/Write tools, or write a `.cjs` edit script with Write and run
  it with node.
- `git config core.autocrlf false` is set locally. The repo is LF (Prettier
  enforces it). If `git status` shows files as modified without a diff, run
  `git update-index --refresh`.
- Docker is **not** installed on the PC, so the image is built only in CI (and
  later on the VPS).

## Running the app locally

`.claude/launch.json` (uncommitted) has these configurations for the preview
pane:

| Name         | What                                                                                                                                                                          | Port |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `server`     | `node --env-file=../../.env --import tsx src/main.ts` with `cwd: apps/server` (**no watch**: `tsx watch` hung from the pane; restart after server changes and new migrations) | 3000 |
| `web`        | Vite dev server, proxies `/api` and `/ws` to :3000                                                                                                                            | 5173 |
| `e2e-server` | `scripts/e2e-server.ts`: fresh temp data dir, fake Claude, password `e2e-password`                                                                                            | 3100 |
| `e2e-web`    | Vite on 5174 proxying to :3100                                                                                                                                                | 5174 |

- The owner's `.env` (gitignored) holds these values:
  - a generated local password, as a comment on line 2 (**never print it in
    chat**);
  - `DATA_DIR=../../data`, which is **his real data: don't create, modify or
    copy anything in it**;
  - `CLAUDE_CODE_OAUTH_TOKEN`, empty since the 2026-09-26 clone: Claude Code
    then uses the PC's own `claude` login (`~/.claude`).
- `launch.json` entries need `"cwd"` for the server: `pnpm --filter … exec`
  still resolves `--env-file` from the repo root. The `e2e-*` entries set `PORT`
  / `VITE_API_TARGET` through `"env"`.
- After editing a zustand store, reload the page: HMR can leave two store
  instances (e.g. the composer ignoring Enter).
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
- **Web unit** (`apps/web/src/**/*.test.ts`): citations, relative time and the
  study-timer engine.
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
  during render (keep it in class instances or effects). `react-hooks/refs`
  also flags handler factories called during render (`onX={make(kind)}`) when
  the handlers touch refs: pass one handler and read the variant from a
  `data-*` attribute (see `AnnotationPopover.tsx`).
- **Playwright and transparent SVG strokes** (the drawings' grab area): the
  locator is "not visible", so click with `page.mouse` at its bounding box.
- **Agent SDK with an image:** the prompt is an `AsyncIterable<SDKUserMessage>`
  with an image block plus the text (`withImage` in `claude/chat.ts`). Checked
  against the real subscription on 2026-09-26.
- **e2e races (fixed 2026-09-26 in `library.spec.ts`):** creating a topic opens
  it, so wait for the new view's heading before uploading; wait for a card's
  processing status to clear before dragging it; use run-unique names (retries
  share the server).
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
