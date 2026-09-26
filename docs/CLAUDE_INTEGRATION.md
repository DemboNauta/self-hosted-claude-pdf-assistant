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
- Verify SDK details against the installed package types
  (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, currently 0.3.x) rather
  than from memory.

## Sandbox (`claude/options.ts`)

`baseAgentOptions(config)` sets:

- `tools: []`: no Bash, Read, Write or WebFetch.
- `allowedTools: []`, then the caller adds its MCP tools explicitly.
- `permissionMode: 'dontAsk'`, `settingSources: []`, `strictMcpConfig: true`.
- `cwd` = an empty `DATA_DIR/agent-cwd`.
- The filtered `env`.
- `model` from `CLAUDE_MODEL`. The Settings override (`settings.claude_model`)
  is applied in `chat.ts` and `brief.ts`.

## Connection status (`claude/status.ts`)

`GET /api/claude/status[?refresh=1]` runs a tiny real query ("Reply with ok"),
cached for 10 minutes. It reports:

- the state: `connected`, `auth_expired`, `rate_limited` or `error`;
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
  - page images for figures;
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
  - the selection, the mode instructions and the summary format;
  - memory from `MemoryService.contextFor(docId)`: global items, document
    items and weakest concepts, with `[id]`s so Claude can update them.

  Then the question follows. With no text typed, the prompt tells Claude to
  apply the mode to the selection.

- Modes (`STUDY_MODES`): `free`, `eli5`, `summary` (+ `prose|outline|glossary`),
  `exam` (one question at a time, uses `record_exam_result`), `relate`
  (searches the same subject first, then all).

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
with a `ToolContext`: thread id, message id, optional `docId`, `scope`, `emit`
and `record`. `allowedTools` is `mcp__pca__<name>`. Every handler is wrapped in
`tracked()`, which emits `tool_event` running/done/error (shown in the chat as
"Leyendo p. 3–5") and stores it with the message.

| Tool                     | Input                                                    | Effect                                                                                   |
| ------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `get_document_info`      | docId                                                    | Title, pages, subject/topic, outline.                                                    |
| `get_pages`              | docId, fromPage, toPage                                  | Page text, max 10 pages, with a truncation note.                                         |
| `get_page_image`         | docId, page                                              | PNG (long side 1400 px) rendered with PDF.js + napi canvas.                              |
| `search_library`         | query, scope doc/topic/subject/all, docId?               | FTS5 hits with «snippets». Defaults to the open doc or the thread's scope.               |
| `list_library`           | —                                                        | Library tree with ids.                                                                   |
| `point_at`               | docId?, page, shapes[] (≤12)                             | Emits `pointer` (ephemeral marks). Anchors: text quote (+occurrence) or normalised rect. |
| `clear_pointers`         | —                                                        | Emits `clear_pointers`.                                                                  |
| `get_annotations`        | docId?, fromPage?, toPage?                               | The student's highlights (with colour meanings) and notes.                               |
| `highlight_key_ideas`    | docId?, highlights[{page, quote, reason}]                | Creates **proposed** Claude highlights; warns about quotes not found.                    |
| `add_note`               | docId?, page, text, quote? or x/y                        | Creates a Claude note.                                                                   |
| `remember`               | scope, docId?, category, content, replaceId?             | De-duplicated memory item.                                                               |
| `mark_concept_difficult` | concept, docId?, page?, evidence                         | Upserts a concept by normalised name, lowers mastery.                                    |
| `update_concept_mastery` | conceptId, delta, evidence                               | Adjusts mastery 0–1.                                                                     |
| `update_progress`        | docId?, note                                             | Document memory, category `progress`.                                                    |
| `record_exam_result`     | docId?, question, userAnswer, correct, concepts[], page? | Stores the result, updates concepts.                                                     |
| `create_flashcards`      | cards[{front, back, page?, docId?}]                      | **Proposed** flashcards.                                                                 |

Tools that change data emit `data_changed` (`annotations` | `memory` |
`flashcards`) so the web invalidates its queries. Tools that need a document
fail with "docId is required" in topic/subject chats.

To add a tool:

1. Add it to one of the `*Tools()` groups, wrapped in `tracked`.
2. Add a label in `t.chat.tools`.
3. If it changes data, emit `data_changed` and handle it in
   `features/annotations/integrations.tsx`.
4. Test the handler directly, as `test/chat.test.ts` and
   `test/annotations.test.ts` do.

## Daily brief (`services/brief.ts`)

This is a one-shot `query` with no tools, `maxTurns: 1`, `persistSession: false`,
and its own system prompt. Claude writes Spanish Markdown about the weakest
concepts plus a "Hoy te propongo:" line. The brief is cached in
`settings.daily_brief` per local day. `POST /api/review/today?day=` generates it,
and Home calls it automatically once a day.

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
    - "señala" → `point_at`;
    - "ideas clave" → `highlight_key_ideas`;
    - "tarjetas" → `create_flashcards`;
    - "recuerda …" → `remember` + `mark_concept_difficult`.
  - Its `result` is the full text, used by the daily brief.
- For a real check without touching the owner's data, run a scratch script
  (not committed):
  - It should call `buildApp(loadConfig({...process.env, DATA_DIR: <temp>}))`.
  - It needs the owner's `.env` loaded (`tsx --env-file=../../.env`).
  - Seed a generated PDF (`test/fixtures/pdf.ts` `makePdf`), then send one
    question over `app.injectWS('/ws/chat')`.
  - Each run uses subscription quota. Keep it to one or two turns.
