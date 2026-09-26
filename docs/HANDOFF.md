# Handoff: context for the next Claude Code session

Last updated: 2026-09-26. See [`README.md`](README.md) for the reading order.

## Who and how

- Single owner, **Edgar**, Spanish speaker. Talk to him in Spanish. Code,
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
`FEATURES.md`). The session stopped in the middle of the **deployment**
milestone:

- Done: the server serves the built web app (`WEB_DIR`, SPA fallback,
  `src/routes/web.ts`). The Docker image builds web + server and runs as one
  container. Compose publishes only `127.0.0.1:${APP_PORT:-3000}`. The bundled
  Caddy is an optional compose profile (`--profile caddy`). Committed as
  `968c351`.
- **Not done yet** (next steps, in order). Details in `DEPLOYMENT.md`:
  1. `scripts/deploy.ps1`.
  2. `deploy/host-caddy.example`.
  3. Rewrite the README "Deploying on a VPS" section. It still describes the old
     bundled-Caddy-only setup.
  4. Document the backup cron (`node dist/backup.js`).
  5. Update the CI `docker` job: the caddy image no longer builds the web.
     Consider building only the server image, plus the caddy image as an
     optional profile.
  6. Try a real image build. Docker is not installed on the owner's PC, so it
     is untested. CI builds it.
  7. Refresh `CLAUDE.md` "Status" (it is out of date; point it to
     `docs/FEATURES.md`).
- After deployment: the owner validates Phase 0 acceptance on the VPS (HTTPS
  login, "Conectado con tu suscripción", server refuses to start with an API
  key), then real use.

## Verification done so far

- `apps/server`: 53 unit/integration tests pass (`vitest`).
- `apps/web`: unit tests pass. The Playwright suite has 24 tests over desktop
  and mobile projects: 21 pass and 3 are skipped on mobile by design (pointer
  drag, drawing, keyboard shortcuts).
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
- Pointer marks are ephemeral and not restored after a reload (by design, F-POINT-03).
- A multi-page text selection highlights only the first page's part.
- The main web chunk is ~1.5 MB (pdf.js + KaTeX + app; the pdf.js worker is a separate
  1.3 MB file). Code-splitting the
  reader would help first load.
- Semantic search (F-SRC-04, Phase 4) is not implemented.
