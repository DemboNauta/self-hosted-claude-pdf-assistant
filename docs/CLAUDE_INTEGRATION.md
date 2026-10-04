# Claude integration

## Non-negotiable: subscription only

- Claude is reached **only** through `@anthropic-ai/claude-agent-sdk`, which
  drives Claude Code with the owner's subscription session:
  - `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or
  - an interactive `/login` stored in `CLAUDE_CONFIG_DIR`.
- Never add `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, never import the
  direct Anthropic SDK, never call the API host.
  - `auth-guard.ts` refuses to start if a key is set, and strips those variables
    (plus base-URL, Bedrock, Vertex and Foundry variables, and the app secrets)
    from the Claude Code env.
  - Every turn checks that `init.apiKeySource` is not an API key.
  - `test/no-api-key.test.ts` scans the repo.
- **One subscription per user** (multi-user, `claude/credentials.ts`):
  - the admin (the server owner, user id `owner`) uses the server's credentials
    above, or a personal token if they save one;
  - every other user must save their own `claude setup-token` token in Settings
    (stored encrypted, `users.claude_token_enc`). Their turns get it as
    `CLAUDE_CODE_OAUTH_TOKEN` and their own `CLAUDE_CONFIG_DIR`
    (`DATA_DIR/claude-users/<id>`), so they never reach the admin's login or
    sessions;
  - unless the admin lets that user use the server's credentials
    (`users.server_claude`, "Dejar usar mi Claude" in `/admin`, 2026-09-28, for the
    owner's own demo accounts). Then, while the user has no personal token (a token
    always wins), turns run as `{ kind: 'server' }`: no token of theirs in the env,
    and their own `CLAUDE_CONFIG_DIR` when the server uses `CLAUDE_CODE_OAUTH_TOKEN`
    (with an interactive login the default config dir is kept, because the login
    lives there; sessions are still only resumed by the ids stored in their own
    threads). Usage counts against the admin's limits.
  - Without a token (or that access), chat turns fail with `not_configured` before any
    query, the brief returns `409 claude_not_configured` and the status says
    `not_configured`.
- Verify SDK details against the installed package types
  (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, currently 0.3.x) rather
  than from memory.

## Sandbox (`claude/options.ts`)

`baseAgentOptions(config, auth)` sets:

- `tools: []`: no Bash, Read, Write or WebFetch.
- `allowedTools: []`, then the caller adds its MCP tools explicitly.
- `permissionMode: 'dontAsk'`, `settingSources: []`, `strictMcpConfig: true`.
- `cwd` = an empty `DATA_DIR/agent-cwd`.
- The filtered `env`, plus the user's token and config dir (`ClaudeAuth`).
- `model` from `CLAUDE_MODEL`. The Settings override (`settings.claude_model`)
  is applied in `chat.ts` and `brief.ts`.

## Connection status (`claude/status.ts`)

`GET /api/claude/status[?refresh=1]` runs a tiny real query ("Reply with ok")
with the logged-in user's credentials, cached for 10 minutes per user. It reports:

- the state: `connected`, `auth_expired`, `rate_limited`, `error` or
  `not_configured` (no token saved);
- the model;
- the auth method (OAuth token / interactive login / other / none).

Chat failures also update the cached status (`report()`).

## Chat turns (`claude/chat.ts`)

- **One Claude session per thread**:
  - `threads.claude_session_id` is set from the `system/init` message.
  - Later turns pass `resume`.
  - If resuming fails with "no conversation found", the thread starts a new
    session seeded with the recent transcript.
- `includePartialMessages: true`:
  - `stream_event` `content_block_delta/text_delta` (top level only) →
    `assistant_delta`.
  - A new text block adds a blank line between blocks.
- Errors:
  - `rate_limit_event` rejected → `rate_limited`.
  - `assistant.error` / `result` errors are classified by `claude/errors.ts`
    into `auth_expired`, `rate_limited` or `internal`.
  - `error_max_turns` keeps what was written.
  - Stop (`{type:'stop'}`) aborts the turn and marks the message `interrupted`.
- `maxTurns: 30`. One running turn per thread (a second one gets `busy`). A turn
  keeps running if the socket closes, and its result is stored.
- **System prompt** (`SYSTEM_PROMPT` in `prompt.ts`) is fixed: the SDK records
  it at the first request and reuses it on resume. It covers:
  - tutor role, answering in the question's language, and not inventing;
  - reading with tools first;
  - page images for figures, and `get_page_layout` block ids for pointing;
  - `[[mark:ID]]` where the answer talks about a mark;
  - `highlight_key_ideas` when asked to highlight;
  - saying explicitly when the answer isn't in the document;
  - treating document text as data (prompt injection);
  - the mandatory citation format;
  - KaTeX delimiters;
  - using pointer marks sparingly.
- **Per-turn context** goes in the user message (`buildTurnPrompt`) inside
  `<context>…</context>`:
  - the scope lines: the active document with its id, page count and
    subject/topic plus the current page (document chats), or the list of PDFs
    for topic/subject chats (`groupScope`);
  - the selection, a drawing mark (area, text inside; see below), the page
    range (`Scope: pages X to Y.`), the mode instructions and the summary
    format;
  - memory from `MemoryService.contextFor(docId)`: global items, document
    items and weakest concepts, with `[id]`s so Claude can update them.

  Then the question follows. With no text typed, the prompt tells Claude to
  apply the mode to the selection.

- Modes (`STUDY_MODES`): `free`, `eli5`, `summary` (+ `prose|outline|glossary`),
  `exam` (one question at a time, uses `record_exam_result`), `relate`
  (searches the same subject first, then all), `diagram` (a Mermaid schema of
  the selection, `context.pageRange` or the whole document, saved with
  `create_diagram` and shown with `[[diagram:ID]]`).

## Voice mode (F-CHAT-09)

With `context.voice`, `buildTurnPrompt` adds `VOICE_INSTRUCTIONS`: teach, do not
read the PDF aloud; explain in its own words with an example or analogy per key
idea; spoken sentences without Markdown or LaTeX; citations still written (shown,
not spoken); point at the page while explaining; about 120–250 words. With
`context.interruptedAfter` Claude is told the student cut in after that sentence
and must answer briefly without continuing the old explanation: the web resumes
it itself (`features/voice/store.ts`). Speech comes from Supertonic 3
(`services/tts.ts`), never from Anthropic.

## Asking about one of Claude's marks

"?" next to a set of marks attaches `context.pointed` (area, labels, text inside
from the text layer). `ChatService.pointedImage` renders that area (padded) and it
goes with the question like a drawing mark; the prompt says the student clicked one
of Claude's marks.

## Images in the user message

When the student asks about an area marked with freehand drawings
(`context.mark`), `ChatService` renders that part of the page with the strokes
on top (`renderMarkImage`, up to 4× zoom) and passes the prompt as an
`AsyncIterable<SDKUserMessage>` whose content is an image block plus the text
(`withImage`). Without drawings (deleted, other page) the text goes alone.
Checked against the real subscription.

## Citations

Format written by Claude: `[[cite:DOC_ID:PAGE|"3–15 words verbatim"]]` (the
quote is optional). `CITATION_RE` and `parseCitation` live in
`packages/shared/src/chat.ts`.

1. The web turns citations into `cite:` Markdown links (`prepareMarkdown`).
   Parentheses are escaped, and a half-streamed citation is hidden.
2. The links render as `CitationChip`s.
3. A click jumps to the page (or opens the other document) and flashes the quote
   found by `textMatch.findQuoteRects`.

## MCP tools (`claude/tools.ts`)

A new in-process server (`createSdkMcpServer`, name `pca`) is built **per turn**
with the turn owner's services (`ToolDeps`, so tools only see that user's data and
reject foreign ids) and a `ToolContext`: thread id, message id, optional `docId`, `scope`, `emit`
and `record`. `allowedTools` is `mcp__pca__<name>`. Every handler is wrapped in
`tracked()`, which emits `tool_event` running/done/error (shown in the chat as
"Leyendo p. 3–5") and stores it with the message.

| Tool                     | Input                                                            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_document_info`      | docId                                                            | Title, pages, subject/topic, outline.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `get_pages`              | docId, fromPage, toPage                                          | Page text, max 10 pages, with a truncation note.                                                                                                                                                                                                                                                                                                                                                                                               |
| `get_page_image`         | docId, page, region?, grid?                                      | PNG (long side 1400 px) rendered with PDF.js + napi canvas. `region` zooms in (up to 4×); `grid` overlays labelled page-fraction coordinates to place rect anchors.                                                                                                                                                                                                                                                                            |
| `get_page_layout`        | docId, page                                                      | Page structure (`ingest/layout.ts`): text blocks `b1…` (heading/text), figures `f1…` (image, vector drawing or both) with their labels `f1.1…`, each with its box. Cached per page (40).                                                                                                                                                                                                                                                       |
| `search_library`         | query, scope doc/topic/subject/all, docId?                       | FTS5 hits with «snippets». Defaults to the open doc or the thread's scope.                                                                                                                                                                                                                                                                                                                                                                     |
| `list_library`           | —                                                                | Library tree with ids.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `point_at`               | docId?, page, shapes[] (≤12), now?                               | Emits `pointer` with a mark id (`m1`, `m2`…) and stores it with the answer. Anchors: `block` id from `get_page_layout` (resolved to a rect here), text quote (+occurrence) or normalised rect; arrows with `to` connect two anchors. Deferred until `[[mark:ID]]` unless `now`.                                                                                                                                                                |
| `go_to_page`             | docId?, page, quote?                                             | Emits `navigate`: the reader moves there with "Seguir a Claude" on, otherwise the student gets a button.                                                                                                                                                                                                                                                                                                                                       |
| `show_side_by_side`      | docId?, page                                                     | Emits `navigate` with `side`: opens that page in the split view (desktop, same follow rule).                                                                                                                                                                                                                                                                                                                                                   |
| `clear_pointers`         | —                                                                | Emits `clear_pointers`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `get_annotations`        | docId?, fromPage?, toPage?                                       | The student's highlights (with colour meanings) and notes.                                                                                                                                                                                                                                                                                                                                                                                     |
| `highlight_key_ideas`    | docId?, highlights[{page, quote, color?, reason}]                | Creates **active** highlights in the student's palette (`color` = palette key, meanings listed in the description; default the first colour), author Claude. Quotes not found are dropped and reported. The ids go in the tool event (`annotationIds`) for "Deshacer".                                                                                                                                                                         |
| `add_note`               | docId?, page, text, quote? or x/y                                | Creates a Claude note.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `add_margin_notes`       | docId?, notes[{page, quote, text, image?: {id, caption?}}] (≤20) | Creates **active** Claude text notes (no accepting step, owner 2026-10-04) shown in the margin (`MarginNotes.tsx`, with edit and delete; "Deshacer" in the chat); notes whose quote is not found are dropped and reported. `image.id` is a picture found by `search_web_images` in the same answer: the server downloads it from Wikimedia (and nowhere else) and stores it with its credit; a failed download keeps the note without it.      |
| `search_web_images`      | query, count? (≤6)                                               | Searches Wikimedia Commons (`services/webImages.ts`, `WebImageProvider`, injectable as `AppDeps.webImages`) and returns small JPEG previews with ids `i1`, `i2`… (per answer), title, size and credit, so Claude picks one.                                                                                                                                                                                                                    |
| `save_whiteboard_to_pdf` | docId?, page, quote?, text                                       | Saves at once a note (quote, or top right of the page below other notes) holding the thread's whiteboard. The saved board follows the thread's board saves until the next turn starts (`saved_boards.pending_thread_id`, `NoteMediaService.followThread` / `settleThread`), so steps revealed later in the answer are included. Fails on an empty board.                                                                                       |
| `remember`               | scope, docId?, category, content, replaceId?                     | De-duplicated memory item.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mark_concept_difficult` | concept, docId?, page?, evidence                                 | Upserts a concept by normalised name, lowers mastery.                                                                                                                                                                                                                                                                                                                                                                                          |
| `update_concept_mastery` | conceptId, delta, evidence                                       | Adjusts mastery 0–1.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `update_progress`        | docId?, note                                                     | Document memory, category `progress`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `record_exam_result`     | docId?, question, userAnswer, correct, concepts[], page?         | Stores the result, updates concepts.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `create_flashcards`      | cards[{front, back, wrong?[3], page?, docId?}]                   | **Active** flashcards (ready to review, no accepting step), with their multiple-choice wrong answers when given.                                                                                                                                                                                                                                                                                                                               |
| `create_diagram`         | title, mermaid, fromPage?, toPage?, docId?                       | Saves a diagram; the answer shows it with `[[diagram:ID]]`.                                                                                                                                                                                                                                                                                                                                                                                    |
| `whiteboard_draw`        | elements[] (≤80), remove?, amend?, mermaid?, clear?              | Draws one step on the thread's whiteboard (`BoardElement`: text, rect/ellipse/diamond with `label` and body `text`, arrow/line `from`/`to` ids or points, freehand, `pdf` crop rendered here as PNG). Returns `wN`, **a preview image of the board** and the problems found (`claude/board.ts`); `amend: "wN"` fixes a step of the same answer instead of adding one. Ids are reusable: drawing one again replaces it; `remove` takes ids off. |
| `whiteboard_view`        | —                                                                | The board's latest snapshot as an image, plus the board area it shows (to place corrections). Marks the board as seen.                                                                                                                                                                                                                                                                                                                         |
| `update_diagram`         | id, mermaid, title?                                              | Replaces a diagram in place (changes the student asks for).                                                                                                                                                                                                                                                                                                                                                                                    |

## Marks in the answer (`[[mark:ID]]`)

`point_at` returns a mark id and Claude writes `[[mark:ID]]` at the start of the
sentence that talks about those marks (`MARK_RE` / `markRefs` in
`packages/shared/src/chat.ts`).

- Written answers: `chat/store.ts` shows a deferred group when the streamed text
  contains its reference (`revealMarks`), once per mark; groups never referenced
  show at `assistant_done`. `now: true` shows it at once (the old behaviour).
- Voice mode: `SentenceSplitter.pushSentences` hands each sentence with its mark
  ids (a mark with no words goes with the next sentence), and the player reveals
  them when that sentence starts. `cleanForSpeech` drops the markup.
- The reference renders as a chip (`MarkChip.tsx`, needs the message id) that
  shows those marks again; `PointerBar` offers "Volver a mostrar…" for all the
  marks of an answer. They come from `ChatMessage.pointers` (`messages.pointers_json`).

Tools that change data emit `data_changed` (`annotations` | `memory` |
`flashcards` | `diagrams`) so the web invalidates its queries. Tools that need a document
fail with "docId is required" in topic/subject chats.

To add a tool:

1. Add it to one of the `*Tools()` groups, wrapped in `tracked`.
2. Add a label in `t.chat.tools`.
3. If it changes data, emit `data_changed` and handle it in
   `features/annotations/integrations.tsx`.
4. Test the handler directly, as `test/chat.test.ts` and
   `test/annotations.test.ts` do.

## Whiteboard

Claude cannot see the browser's board while it answers, so the server gives it its
own picture: `claude/board.ts` measures text with Excalifont (Latin subset in
`apps/server/assets/fonts`, the font the browser draws with), grows boxes to fit
their text (the grown `h` is stored in the step), renders a rough preview (straight
lines, real font, the board's right edge dashed) and lists problems: text starting
inside a box that already has text, overlapping texts or boxes, things past x 1000.
The browser loads Excalifont before converting a step, so its wrapping matches.

The system prompt has a "Whiteboard" section (when drawing helps, several steps,
each with its `[[mark:wN]]`). Steps are stored in `whiteboards.steps_json` and sent
as `board_step`; `MARK_RE` accepts `w` ids, and `revealMarks` in the chat store
hands them to the board (written answers: when the text reaches them; voice: when
the sentence is spoken; unreferenced ones at the end).

The student's drawings: the browser saves a PNG snapshot with the scene and flags
saves that follow the student's own pointer or key input (`studentEdited`). The turn
context (`buildTurnPrompt` `board`) then says the student drew since Claude last
looked (or just that the board has content), and Claude calls `whiteboard_view`;
the prompt asks it to say what is right and mark mistakes in red next to them.
"Revisar mi pizarra" saves the board and sends a fixed request.

## Daily brief (`services/brief.ts`)

This is a one-shot `query` with no tools, `maxTurns: 1`, `persistSession: false`,
and its own system prompt. Claude writes Spanish Markdown about the weakest
concepts plus a "Hoy te propongo:" line. The brief is cached in
`settings.daily_brief` per local day. `POST /api/review/today?day=` generates it,
and Home calls it automatically once a day.

## Flashcards written by Claude (`services/cardgen.ts`)

One-shot queries like the brief (no tools, `maxTurns: 1`, own system prompt), with
the user's own Claude credentials (`credentials.forUser`):

- `generate(source, count)` (`POST /api/flashcards/generate`, and 5 cards a day from
  `brief.generate` on the first Home visit, once per day): sends the text of pages
  the student has **read** (`pages.viewed_at`) of the chosen subjects/topics/documents
  (default: the 5 opened last), up to ~32k characters, pages without cards first,
  plus the existing card fronts so Claude does not repeat them. Claude answers a JSON
  array `[{ref, page, front, back, wrong[3]}]`; cards are created **active** (ready
  to review). Unknown refs are dropped; a page Claude was not shown becomes null.
- `fillDistractors(ids)` (`POST /api/flashcards/distractors`, ≤20): writes the three
  wrong answers of cards that have none (the student's own, older or edited cards),
  one request for all. The review screen calls it in the background for the next 10
  due cards; cards keep "Mostrar respuesta" until theirs arrive. Wrong answers equal
  to the right one or repeated are discarded (fewer than three → the card stays
  without options).
- The cards prompt forbids questions about the document itself (how it is organised,
  what a module covers, what comes first); cards are created in random order so the
  review interleaves them.
- `hint(id)` (`POST /api/flashcards/:id/hint`): one short hint from the question, the
  right and wrong answers and the source page, without giving the answer or the
  right option away. A right answer after a hint is rated «Difícil» (client side).

## Testing without the subscription

- Unit tests pass `claudeQuery` (and a fake status query) through `authedApp(...,
{ claudeQuery })`. The fake is an async generator yielding SDK-shaped messages
  (see `test/chat.test.ts` `streamText`).
- `scripts/e2e-server.ts` (Playwright):
  - It streams a canned answer citing page 1 (quoting the selection, if any)
    with a KaTeX formula.
  - It calls the **real** tool handlers through
    `options.mcpServers.pca.instance._registeredTools` when the question
    contains a trigger word:
    - "señala" → `point_at` (the answer starts with the returned `[[mark:ID]]`);
    - "ideas clave" → `highlight_key_ideas` (direct highlight of the selection);
    - "tarjetas" → `create_flashcards`;
    - "nota al margen" → `add_margin_notes` on the selection (with "imagen", after
      `search_web_images`, with picture `i1`; the e2e server's `webImages` returns a
      green square);
    - "guarda la pizarra" → `save_whiteboard_to_pdf` on page 1;
    - "conecta" → `point_at` with an arrow from the selection to a rect (`to`);
    - "larga" → 40 more paragraphs streamed (chat scrolling tests);
    - "recuerda …" → `remember` + `mark_concept_difficult`;
    - "ve a la página" → `go_to_page` 2; "al lado" → `show_side_by_side` 2; "numera" →
      `point_at` with two numbered badges and a callout on page 1;
    - "pizarra" → two `whiteboard_draw` steps (boxes, then an arrow and a formula);
    - "revisa" → `whiteboard_view`, then a red correction below the drawing ("He mirado
      tu pizarra");
    - diagram mode → `create_diagram` with a small mind map, answered with
      `[[diagram:ID]]`.
  - Its `result` is the full text, used by the daily brief.
  - One-shot requests are told apart by their system prompt: "write flashcards"
    answers one card per page shown (with fixed wrong answers) and "wrong options"
    answers the same three wrong answers for every card; "You give hints" answers
    "Pista de prueba." (checked first: its prompt also mentions wrong options).
- For a real check without touching the owner's data, run a scratch script
  (not committed):
  - It should call `buildApp(loadConfig({...process.env, DATA_DIR: <temp>}))`.
  - It needs the owner's `.env` loaded (`tsx --env-file=../../.env`).
  - Seed a generated PDF (`test/fixtures/pdf.ts` `makePdf`), then send one
    question over `app.injectWS('/ws/chat')`.
  - Each run uses subscription quota. Keep it to one or two turns.
