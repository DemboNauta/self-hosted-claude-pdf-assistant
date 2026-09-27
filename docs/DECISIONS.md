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
| 5   | Voice                   | Listening: the browser's Web Speech API (dictation button and voice mode). Speaking (voice mode, F-CHAT-09): Supertonic 3 voices on the VPS, free and local. See "Voice mode" below.                                   | Owner       |
| 6   | Max PDF size            | No limit (`MAX_UPLOAD_MB=0`). Uploads are chunked and streamed to disk, long books use per-page text and a virtualised viewer. URL imports are capped at 1 GB when the limit is 0 (`DEFAULT_URL_LIMIT`).               | Owner       |
| 7   | Usage counter           | No counter. The app only shows a clear message when the subscription limit is hit (`rate_limited`).                                                                                                                    | Provisional |

## Other owner decisions

- **Visual interaction with the PDF (2026-09-27).** The owner asked how Claude could
  interact better visually and chose, in this order: precise pointing
  (`get_page_layout`), marks tied to the explanation (`[[mark:ID]]`) and marks that
  can be shown again (done); then a **whiteboard**; then follow mode, split view and
  richer shapes. His answers for what comes next:
  - Whiteboard: a **tab next to the chat** (with a button to enlarge it),
    **hand-drawn style** (Excalidraw; accepted that it looks different from the
    minimalist UI), and **the student draws too and Claude corrects** (it gets the
    board as an image).
  - Follow mode: Claude moves the viewer **only while a "seguir" toggle is on**;
    otherwise it offers an "Ir a p. X" button.
- **Claude's highlights (2026-09-27).** When asked "subráyame lo más importante de
  las páginas X", Claude highlights **directly** (saved as active, not proposals) in
  the **student's semantic colours** (yellow important, green definition…; not the
  student's own states such as "no lo entiendo" unless asked), author Claude. The
  chat offers **"Deshacer"** to remove that answer's highlights in one go.

- **Voice mode (2026-09-26, F-CHAT-09).** The owner asked for talking to Claude like
  Gemini Live / Claude voice: free, a good voice, responsive, microphone always
  open, able to cut Claude off with a question and have it carry on. Decisions:
  - Claude speaks with **Supertonic 3** voices synthesised **on the VPS**
    (2026-09-27; it replaced Piper, which the owner found robotic). Found through
    debpalash/VoiceStudio (AGPL, GPU-oriented, not usable as such; only its engine
    catalogue helped). Owner's ear test against Piper: **F1 (female, default)** and
    **M1 (male)**, clearly more natural. **5 denoising steps** (owner: sounds almost
    like the default 8, ~40 % faster). Measured on the owner's PC with 2 threads:
    ~0.15 s of compute per second of audio (Piper: 0.07), ~2 s to load the model on
    the first sentence, ~550 MB of RAM while loaded (unloaded after 10 idle
    minutes). Model weights under OpenRAIL-M, accepted by the owner; the sample
    code we adapted is MIT. Speed is adjustable. Audio plays inside the page, so
    the microphone's echo cancellation can remove it.
  - Listening uses the **browser's speech recognition** (owner's choice over
    Whisper on the VPS, which would be slower). Main device: **Android**.
  - Claude must **teach, not read**: explain in its own words with examples and
    analogies, never a text-to-speech of the PDF (owner's explicit request).
  - Interrupting: speaking over Claude stops it; Claude answers the question
    briefly and then the app **resumes the explanation** from the sentence that
    was cut ("Sigo con lo que te estaba contando."). "Sigue" / "espera" work as
    spoken commands.
  - Echo (owner, after trying it with loud headphones): the microphone is opened
    with echo cancellation, noise suppression and gain control, and newer
    Chrome/Edge recognise from that cleaned track; an interruption needs a voice on
    it (level above the room noise), 2+ words (or "espera", "para", "oye"), not
    matching what Claude is saying, and not right after a question.
  - Moving around the PDF while listening must not change the subject:
    interruptions are sent with the page being explained (where it started, then
    where Claude points); new questions use the page on screen.
  - **Podcast style** (owner): Claude does not stop to ask whether to go on. After
    each spoken answer the app asks it to carry on (`context.continueExplaining`,
    shown as a small "Sigue explicando" line) until the student talks, pauses, or
    Claude closes the topic with `[[voice-end]]` (hidden, not spoken).
  - The screen stays on while voice mode runs (Wake Lock): a locked phone would
    cut the microphone.
  - **Android is half-duplex** (after the owner's first phone tests): each start of
    the recognition took the audio focus and paused Claude's voice (heard as
    skipped sentences), and the extra echo-cancelled microphone blocked the
    recognition. On Android the microphone rests while Claude talks and the
    student cuts in with the "Preguntar" button (also shown on desktop); no second
    microphone is opened there.

- **Claude on the page (2026-09-27).** Claude's pointer marks must not get in the
  way once it has finished: they fade after the answer (and its speech) and have a
  × to remove them. The owner chose "point inside figures" and "margin notes" from
  a list of ideas (not the guided voice tour or word-by-word highlighting). Margin
  notes are proposals the student keeps or discards; with no free margin they fold
  into a tab so they never cover the text (Claude's call, after seeing them on a
  phone).
- **Highlights on dark PDF pages (2026-09-27):** they must stand out (they were
  barely visible); done with the screen blend mode.
- **Flashcards by Claude (2026-09-27).** Home shows a minimum of stats (the owner
  picked: 30-day chart, cards of the day, weak concepts). Claude writes **new
  cards, ready to review** (not proposals, and not a quiz session): a few every
  day on the first visit to Home, and on demand in "Repaso" choosing subjects,
  topics or PDFs, always from what was already read.
- **Multiple choice (2026-09-27).** Every card is answered by choosing among **4
  options** (faster than "Mostrar respuesta"), rated **automatically**: wrong =
  "Otra vez", right = "Bien", or "Fácil" when fast. Claude writes the wrong
  answers, also for the student's own cards.
- **Hints and card content (2026-09-27, after the first real cards).** A "Pedir
  pista" button asks Claude for a hint; a right answer after it counts as
  «Difícil» ("neither right nor wrong"), a wrong one still «Otra vez». Cards must
  not ask about the order or structure of the notes (a real card asked "what case
  is studied first in the module"), and new cards come in random order.
- **Stats chart:** hovering or tapping a day shows its time in hours/minutes.

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
- Visual schemas (2026-09-26): Claude picks the diagram type (mind map, tree or
  flowchart). Scope: whole PDF, a page range or the selected text. Every
  diagram shows in the chat and is kept in a per-PDF "Esquemas" panel and a
  general "Esquemas" page. Changes are asked to Claude in the chat, which
  updates the same diagram (no manual editing).
- Deployment target (2026-09-26): the same VPS as his `garmin-ia` project. The
  app runs like the other apps there, as a **systemd service behind the shared
  Caddy, without Docker**. The subdomain follows the Cloudflare mode of his other
  subdomains (Flexible). See `DEPLOYMENT.md`.
- Reopening a document must resume at the page where the reading stopped, also
  when navigating inside the app (bug fixed 2026-09-26).

- **Multi-user (2026-09-26).** The owner asked for several users and chose:
  - each user connects **their own Claude subscription** (a `claude setup-token`
    token pasted in Settings, stored encrypted). Sharing the owner's subscription
    would go against its personal-use terms (SPEC §6.1). Without a token a user can
    read, annotate and review, but not use Claude;
  - accounts are created **by the admin** (username + initial password) **and by
    single-use invitation links**; no open registration;
  - **full isolation**: nobody sees anyone else's library, annotations, chats,
    memory, cards or stats, not even the admin;
  - the existing production data **goes to the admin account**.
  - **one name per account** (owner, 2026-09-26): the username is also the name
    shown; there is no separate display name (migration `0013`).

## Provisional product choices (Claude, "don't ask until deploy")

- **Multi-user details** (choices Claude made while implementing the owner's
  decisions above):
  - The admin is the existing owner: username `admin` (changeable in Ajustes),
    password from `APP_PASSWORD_HASH`. The app keeps a password changed in
    Ajustes until that variable changes (so `deploy.ps1 -SetPassword` still works).
  - There is one admin, and nobody can be promoted. Only the admin may use the
    server's Claude credentials (`CLAUDE_CODE_OAUTH_TOKEN` / interactive login).
    The admin can also save a personal token instead.
  - Invitation links expire after 7 days, work once and can be revoked. The admin
    sees only the username, PDF count, whether Claude is connected and last
    login. They can disable, re-enable, reset the password or delete (with all data).
  - The backup download (Settings) is admin-only, because it contains every user's
    data. The admin already owns the server, so it is not a new exposure.
  - Changing your password logs out your other sessions. An admin reset or
    disabling logs the user out everywhere.

- **Pointer marks jump the viewer** to the page Claude points at (F-POINT-05
  offered "jump or show a notice"). The chat also shows "Claude ha señalado en la
  p. N · Ir". **Superseded 2026-09-27 by the owner:** the viewer only moves with
  "Seguir a Claude" on (off by default); otherwise a button offers to go.
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

- **Study timer** (2026-09-26, owner request: "un sistema de métodos de estudio, el
  pomodoro y cosas así"). Asked and answered by the owner: methods = classic Pomodoro,
  presets and custom (no Flowtime); a floating widget on the whole app that can be
  moved out of the way; sound and a break screen (no browser notifications); blocks
  saved in the statistics; Claude does not take part. Claude's choices:
  - Presets: Pomodoro 25/5 with a 15-minute break every 4, long Pomodoro 50/10 (30
    every 3), 52/17 and ultradian 90/20 (no long break).
  - Breaks start by themselves; the next focus block waits for the user ("Se acabó el
    descanso" prompt) unless "Empezar el siguiente bloque" is on.
  - The running timer lives in `localStorage` (survives reloads, shared across tabs);
    its options are server settings (`study_timer`).
  - A completed block counts as a pomodoro and makes the day active for the streak.
    A block cut short (skip/reset) after at least a minute adds focus time only. The
    block is credited to the PDF open in the reader when it ends.
  - Focus time is shown apart from reading time (no double counting).

- **Marks timing (2026-09-27, Claude).** `point_at` marks are deferred by default
  and appear when the answer reaches their `[[mark:ID]]`; a mark never referenced
  appears when the answer ends (so a forgotten reference only delays it), and
  `now: true` keeps the old immediate behaviour. A mark shows on its own once: if
  the student dismisses it, only the chip or "Volver a mostrar…" brings it back.
- **Whiteboard details (2026-09-27, Claude).** The panel switches to the board by
  itself when Claude draws (the answer stays readable in a strip below). Claude draws
  with a small vocabulary turned into Excalidraw elements in the browser, on a
  1000-unit-wide board; maths as Unicode (no LaTeX on the board). One board per chat
  thread, the student can draw on it, and the scene is saved a moment after each
  change. Mermaid on the board goes through `@excalidraw/mermaid-to-excalidraw`,
  which brings its own Mermaid 11 (only in the lazy board chunk). Excalidraw's fonts
  are served by the app (CJK font left out, 13 MB).
- **Whiteboard preview (2026-09-27, owner's report: "Claude no ve lo que hace, el
  texto se solapa").** Every `whiteboard_draw` returns a server-rendered preview of
  Claude's drawing and a list of overlaps, and Claude fixes them with `amend` before
  explaining. Boxes take a body `text` under their heading and grow to fit it. The
  preview shows only Claude's elements (the student's strokes are not in it) and
  approximates the hand-drawn look with straight lines; text is measured with the
  real font. Costs one small image per drawing call.
- **Student drawings (2026-09-27, Claude).** Claude does not get the board with every
  question (quota): it is told in the turn context when the student changed the board
  since it last looked, and looks with `whiteboard_view`. A save counts as the
  student's when it follows their pointer or key input on the board by less than 3 s.
  "Revisar mi pizarra" (under the board) asks Claude to check the work.
- **Block 4 details (2026-09-27, Claude).** "Seguir a Claude" is a reader toolbar
  toggle kept in the browser. Offers expire after 15 s. Replaying marks from the chat
  (chip, "Volver a mostrar…") always moves the reader: the student asked for it. The
  split view shows one page at a time (with page buttons) and Claude's marks on it;
  it is desktop only (phones get the offer, which opens the page in the reader); no
  arrows between the two panes. Numbered badges sit in the left margin of the
  passage; callouts go beside it where there is room (right, then left, else below).
- **Page layout (2026-09-27, Claude).** Built on demand from the stored text items
  plus the PDF operator list (image placements and path bounds), not at ingestion:
  vector clusters with a single stroke or under 3 % of the page in both directions
  count as decoration; text inside a figure becomes its labels. Tables drawn with
  rules therefore show up as figures with labels.

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
