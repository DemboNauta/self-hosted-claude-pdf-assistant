# Handoff: context for the next Claude Code session

Last updated: 2026-09-26 (multi-user and voice mode committed, **not deployed yet**; revision `88d6dcf` in production). See [`README.md`](README.md) for the reading order.

## Who and how

- Owner and admin, **Edgar**, Spanish speaker (the app is multi-user since
  2026-09-26; he is the admin). Talk to him in Spanish. Code,
  comments, commits and docs are in English; UI text is in Spanish
  (`apps/web/src/i18n/es.ts`).
- Standing instruction from the owner (latest): **keep going through the phases
  and do not ask questions until everything is ready for deployment.** Take
  reasonable defaults and record them in `DECISIONS.md` as provisional.
  Otherwise his general rule is to ask about product, UX or data questions; he
  leaves technology choices to Claude.
- Work directly on `main`, one commit per milestone, Conventional Commits with a
  scope (`feat(reader): …`) and feature IDs in the body.
- Commit author must be `Edgar <edgarmila_10@outlook.com>` (local git config).
  **Never** add `Co-Authored-By` or anything that attributes commits to Claude.
- **Never put the domain, the VPS IP or any VPS detail in the repo** (files,
  commits, docs). They live only in the VPS `.env`, the VPS Caddyfile and
  environment variables on the owner's PC. Ask him for them when needed.
- Commits have **not been pushed** to GitHub. Ask before pushing.
- **Don't touch the owner's local data** (`data/` at the repo root). He uses the
  app with his own PDFs, and copying or reading them is off-limits (it was
  denied once). For manual tests, use the sandbox e2e server or a temp
  `DATA_DIR` with generated PDFs (see `DEVELOPMENT.md`).

## Where the work stopped

Phases 1, 2 and 3 of SPEC §13 are implemented, with unit and e2e tests (see
`FEATURES.md`).

Session of 2026-09-26: the owner tried the app locally (fresh clone, see
`DEVELOPMENT.md` "Fresh clone") and asked, **before the deployment**, for:

- Note windows that fit the screen (bottom sheet on phones), resize, move and
  can be pinned open; saved on the server (`annotations.display_json`).
- Sticky notes and drawings movable by dragging.
- "Preguntar" about freehand drawings: pen toolbar button (drawings since the
  last question) or the drawing's window. Claude gets the text inside the area
  plus a server-rendered image with the drawing (`renderMarkImage`). Tried with
  the real SDK.
- Fix: reopening a document inside the app resumed at the stale page (cached
  detail); now the detail query is dropped on leaving the reader.

Later the same day the owner asked for a mark on the page wherever he asked Claude
about a selection, to find the question and the answer again. Done as "question
marks" (`apps/web/src/features/chat/QuestionMarks.tsx`, `GET
/api/documents/:id/questions`); see `DECISIONS.md`. It was built in a cloud session
on branch `claude/zen-turing-8lrljs` and merged into `main`.

Then visual schemas: an "Esquema visual" chat mode (whole PDF or pages) and a
selection action. Claude draws Mermaid (`create_diagram` / `update_diagram`),
shown in the chat and kept in the reader's "Esquemas" panel and the `/diagrams`
page (`apps/web/src/features/diagrams`). Only tried with the fake Claude: check
with real Claude that its Mermaid renders well on real PDFs.

Then a study timer (Pomodoro and other methods): floating, draggable widget, break
screen, chime and pomodoros in the statistics (`apps/web/src/features/timer`,
`POST /api/focus-sessions`). Built in a cloud session on branch
`claude/nifty-noether-7b2tc8`, reviewed and fast-forwarded into `main`; the owner
has not tried it yet.

The owner tried the diagrams in production ("parece que lo hace bien") and asked
for a better viewer: the full-screen viewer is now a canvas with free zoom and pan
(wheel or trackpad pinch around the pointer, drag, two-finger pinch on touch,
double click, keyboard), no scrollbars (`features/diagrams/PanZoom.tsx`).

Then **multi-user** (built in a cloud session on branch
`claude/nifty-noether-7b2tc8`). The owner decided: each user brings their own
Claude token, accounts come from the admin or single-use invitation links, data is
fully isolated, and the existing data goes to the admin (`DECISIONS.md`).

- Server:
  - migration `0012` (users, invitations, `user_settings`, `user_id` everywhere);
  - per-user services (`services/scope.ts`), `UserService`, `SecretBox`
    (encrypted tokens);
  - `claude/credentials.ts`: whose subscription a turn uses; per-user status.
- Web: login with username, `/invite/:token`, Ajustes → Tu cuenta and «Tu token
  de Claude», `/admin` (accounts and invitations; sidebar "Usuarios" for the admin).
- **Before deploying**, tell the owner: after the deploy he logs in as **`admin`**
  with his current password. He can rename the account in Ajustes. Not tried yet
  with real Claude for a second user (needs a second subscription's token).

Then the owner asked for a single name per account (the username; migration `0013`
drops `display_name`) and for **voice mode** (F-CHAT-09, see `DECISIONS.md` "Voice
mode"): always-open microphone, Claude explains out loud (teaching with examples,
never reading the PDF), can be interrupted with a question and then carries on.
Claude's voice is Piper on the VPS (voices picked by the owner: sharvard female,
davefx male); listening is the browser's speech recognition. Tested with a fake
microphone/voice/Claude (e2e) and the real Piper on Windows; **not yet tried on the
owner's Android** nor with real Claude in voice mode. Things to watch there: whether
Claude's voice triggers false interruptions (the text echo filter in
`features/voice/speech.ts` `isEcho` is the safety net; headphones avoid it),
Android Chrome's recognition restarts, and the quality of Claude's spoken answers. The owner's first try (desktop, loud headphones) had Claude cutting itself off; fixed with echo cancellation and a voice-level gate (see DECISIONS). On his Android phone (Chrome) voice mode did not respond at all: the recognition refuses the microphone while the echo-cancelled one is open, and a `not-allowed` error was taken as a denied permission. Now `Listener` falls back by itself (`MicMode`: track → meter → plain) and starts inside the tap. Not yet re-checked on the phone. Diagnostics on screen: open the app with `?vozdebug=1` (`=0` to turn off); the voice bar then lists the mic mode, level, errors and what was heard.

Decisions are in `DECISIONS.md` (2026-09-26 entries). The owner may still have
feedback on these; then continue with the deployment below.

The **deployment** milestone:

- Done:
  - The server serves the built web app (`WEB_DIR`, SPA fallback,
    `src/routes/web.ts`). The Docker image builds web + server and runs as one
    container. Compose publishes only `127.0.0.1:${APP_PORT:-3000}`. The bundled
    Caddy is an optional compose profile (`--profile caddy`).
  - Native deploy (2026-09-26): the VPS (same as `garmin-ia`) has no Docker,
    so the app runs as a systemd service behind the shared Caddy.
    `scripts/deploy.ps1` + `scripts/deploy-remote.sh`; details in
    `DEPLOYMENT.md`. The first deploy is done: release installed, unit enabled,
    Caddy block live.
- **In production since 2026-09-26** and Phase 0 accepted (see
  `DEPLOYMENT.md` "Status"). Deploy new commits with `.\scripts\deploy.ps1`
  (`PCA_DEPLOY_HOST` and `PCA_DOMAIN` set in the shell; the host is the
  `known_hosts` entry of the `garmin-ia` VPS). Commits are still unpushed; the
  Docker image (alternative) is only built by CI.

## Verification done so far

- `apps/server`: 76 unit/integration tests pass (`vitest`), 9 of them for
  multi-user isolation, invitations, admin rights and per-user Claude
  (`test/users.test.ts`), 4 for voice (`test/tts.test.ts`).
- `apps/web`: 15 unit tests pass (citations, relative time, timer engine, speech
  splitting). The Playwright suite has 40 tests over desktop and mobile projects:
  35 pass and 5 are skipped on mobile by design (pointer drag, drawing, keyboard
  shortcuts).
- Real Claude, run through the owner's subscription with a temp data dir and
  generated PDFs:
  - A document question: Claude used `get_pages`, answered with correct
    citations and quotes, in about 9 s.
  - A pointing request: `point_at` highlighted the right quote with a label.
- Not yet tried against real Claude: exam mode (with `record_exam_result`),
  `highlight_key_ideas`, `create_flashcards`, the daily brief, topic chat and
  `get_page_image`. They are covered only by the fake Claude.
- The owner saw the library and the viewer locally. He has not tried the later
  features yet.

## Known limitations / ideas not done

- `get_page_image` and the OCR re-extraction run synchronously on the main
  thread (page render) or in the ingest queue (OCR). This is fine for a single
  user.
- The Chromium bundled in some sandboxes is older than what pdfjs-dist needs
  (`Map.prototype.getOrInsertComputed`), so PDF pages never render there and every
  reader e2e test fails. Running the suite with that method polyfilled via
  `page.addInitScript` makes it pass. Real browsers the owner uses may need the
  same check.
- Pointer marks are ephemeral and not restored after a reload (by design, F-POINT-03).
- A multi-page text selection highlights only the first page's part.
- The main web chunk is ~1.5 MB (pdf.js + KaTeX + app; the pdf.js worker is a separate
  1.3 MB file). Code-splitting the
  reader would help first load.
- Semantic search (F-SRC-04, Phase 4) is not implemented.
