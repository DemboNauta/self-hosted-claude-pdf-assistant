# Decisions

Settled product and technical decisions. **Owner** = decided by Edgar; don't
reopen them without asking. **Provisional** = taken by Claude when the owner said
"don't ask until deploy". Mention them to the owner when you get the chance, and
change them if he disagrees.

## Open decisions from SPEC §14

| #   | Topic                   | Decision                                                                                                                                                                                                               | By          |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | Visual style            | Minimalist, typographic: Inter for UI, Source Serif 4 for headings, neutral warm greys (`apps/web/src/styles.css`).                                                                                                    | Owner       |
| 2   | Highlight colours       | yellow = important, green = definition, blue = example, red = don't understand, purple = review. Claude uses its own orange (`#e8590c`). Colours and meanings are editable in Settings (stored in `settings.palette`). | Owner       |
| 3   | Claude's reply language | The language of the student's question (in the system prompt).                                                                                                                                                         | Owner       |
| 4   | Semantic search         | Not implemented (Phase 4). FTS5 only.                                                                                                                                                                                  | Provisional |
| 5   | Voice                   | Browser Web Speech API (`features/chat/dictation.ts`); no server-side transcription. Switch to local Whisper if it works badly on his devices.                                                                         | Provisional |
| 6   | Max PDF size            | No limit (`MAX_UPLOAD_MB=0`). Uploads are chunked and streamed to disk, long books use per-page text and a virtualised viewer. URL imports are capped at 1 GB when the limit is 0 (`DEFAULT_URL_LIMIT`).               | Owner       |
| 7   | Usage counter           | No counter. The app only shows a clear message when the subscription limit is hit (`rate_limited`).                                                                                                                    | Provisional |

## Other owner decisions

- Deleting a subject or topic that still has PDFs moves those PDFs to the trash
  for 30 days. Restoring asks for a destination topic.
- Phase 1 started before Phase 0 was validated on the VPS.
- Upload limit behind Cloudflare: the domain is on Cloudflare (proxied). He
  chose **resumable chunked uploads** (32 MiB chunks, `/api/uploads`) over "DNS
  only" or a 100 MB cap.
- He wanted to see the app locally first, and deploy later.
- Library layout: tree of subjects and topics on the left, card grid of the
  selected topic on the right. On phones these are two screens.
- Claude interaction scope: "everything Claude": chat, modes, pointer marks,
  memory, page images, proposals.
- Order: viewer, then chat, then annotations, then the rest.
- Deployment follows his other project's approach:
  - A `deploy.ps1` run from his Windows PC over SSH, with the host taken from an
    environment variable.
  - Code copied with scp, never touching the server `.env` or `data/`.
  - The VPS already runs its **own Caddy outside Docker**, so the app container
    listens on `127.0.0.1:<port>` only and his Caddy reverse-proxies the
    subdomain.
- Annotation windows (2026-09-26):
  - The note window adapts to the screen: a floating window on desktop and
    tablet, a bottom sheet on phones. The user can resize it.
  - It can be moved (drag its header) and **pinned open**. The pinned state,
    position (page space) and size are **stored on the server**, so every
    device shows them the same way.
  - Sticky notes (point notes) and drawings can be moved by dragging them.
    Highlights stay on their text.
- Asking Claude about a drawing (2026-09-26):
  - Only through a button: "Preguntar" in the pen toolbar (for the drawings made
    since the last question) or in a drawing's window. No menu pops up by itself.
  - Claude gets the text inside the marked area **and an image** of that area
    with the drawing on top.
  - The drawings stay as normal annotations.
- Deployment target (2026-09-26): the same VPS as his `garmin-ia` project. The
  app runs like the other apps there, as a **systemd service behind the shared
  Caddy, without Docker**. The subdomain follows the Cloudflare mode of his other
  subdomains (Flexible). See `DEPLOYMENT.md`.
- Reopening a document must resume at the page where the reading stopped, also
  when navigating inside the app (bug fixed 2026-09-26).

## Provisional product choices (Claude, "don't ask until deploy")

- **Pointer marks jump the viewer** to the page Claude points at (F-POINT-05
  offered "jump or show a notice"). The chat also shows "Claude ha señalado en la
  p. N · Ir".
- **Daily brief** ("Repaso de hoy"): Claude writes it once per local day,
  automatically when Home opens and there is something to review. It is cached
  in `settings.daily_brief` and can be regenerated with a button. This costs one
  short request per day.
- **Memory panel** is read-only (the SPEC says so). Claude de-duplicates on
  write: word-overlap Jaccard ≥ 0.6 within the same category updates the
  existing item.
- **Exam results** lower mastery by 0.15 per failure and raise it by 0.1 per
  correct answer. New difficult concepts start at 0.25.
- **OCR** replaces the served file with the OCR'd copy and keeps the original as
  `<id>.orig.pdf`. Existing annotations remain valid (same page geometry).
- **Reading time** counts only while the tab is visible and there was input in
  the last 2 minutes. It is flushed with position saves and every minute.
- **Dark mode for PDF pages** (F-VIS-04) is on by default when the dark theme is
  active, with an independent toggle in Settings.
- **Keyboard shortcuts:**
  - j/k: pages.
  - g: page field.
  - +/−/0: zoom.
  - 1–5: highlight the selection.
  - c: chat.
  - /: search.
  - t, i, a, m: panels.
  - d: pen.
  - Esc: back out.
  - ?: help.
- **Question marks** (2026-09-26, owner request: "que se quede una marquita para
  ver que ya preguntaste y ver la respuesta"): derived from the chat history, not
  stored as annotations. Every user message with a selection or drawing mark
  becomes a dotted underline plus an orange badge in the right margin; questions
  about the same passage share one badge (with a count). The badge opens a dialog
  with each question and its answer and a "Ver en el chat" link. Deleting a thread
  removes its marks. They follow the annotations' show/hide toggle. Selections now
  carry their rects (`selection.rects`); older questions are located from the text.
- **Model** can be overridden in Settings (`settings.claude_model`). It takes
  precedence over `CLAUDE_MODEL` for chat and the daily brief (not for the status
  probe).

## Technical decisions worth knowing

- Claude is reached **only** via `@anthropic-ai/claude-agent-sdk` with the
  subscription. `apps/server/test/no-api-key.test.ts` enforces that no API key,
  API host or direct SDK import appears anywhere.
- One Claude Code session per chat thread, resumed with `resume`. If the session
  is lost, a new one is seeded with the recent transcript.
- Per-turn context (page, selection, mode, memory) goes in the **user message**:
  the SDK snapshots the system prompt on the first request.
- Anchors are stored in normalised page space (0–1, top-left). The browser finds
  quotes in the PDF.js text layer. The server resolves quote-only anchors from
  the stored text items (`services/anchoring.ts`).
- FSRS via `ts-fsrs`, with fuzz enabled.
- Backups: a tar.gz with an online SQLite snapshot plus `pdfs/` and `covers/`,
  never `claude-home/`.
