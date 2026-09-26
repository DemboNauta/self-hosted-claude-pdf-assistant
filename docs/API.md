# API reference

Everything under `/api` and `/ws` needs the session cookie, except
`POST /api/auth/login`, `GET /api/auth/session` and `GET /api/health`. Request
bodies are validated with Zod schemas from `packages/shared/src/*`; invalid input
returns `400 { error: 'invalid_request' }`. Errors are always `{ error: code }`.
Ids are 10-char base36 strings.

## Auth and status

| Method | Path                           | Notes                                                                               |
| ------ | ------------------------------ | ----------------------------------------------------------------------------------- |
| POST   | `/api/auth/login`              | `{ password }`. Limited to 5 attempts per minute (the e2e server raises the limit). |
| POST   | `/api/auth/logout`             |                                                                                     |
| GET    | `/api/auth/session`            | `{ authenticated }`                                                                 |
| GET    | `/api/health`                  | `{ ok: true }`                                                                      |
| GET    | `/api/claude/status?refresh=1` | `ClaudeStatus` (cached 10 min unless refresh).                                      |

## Library

| Method | Path                                                       | Body / query → response                                                                       |
| ------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/api/library`                                             | `LibraryTree` (subjects → topics → `DocumentSummary[]`).                                      |
| POST   | `/api/subjects`                                            | `{ name, color? }`                                                                            |
| PATCH  | `/api/subjects/:id`                                        | `{ name?, color? }`                                                                           |
| DELETE | `/api/subjects/:id`                                        | Its topics are deleted and their PDFs go to the trash.                                        |
| POST   | `/api/subjects/reorder`                                    | `{ ids }`                                                                                     |
| POST   | `/api/topics`                                              | `{ subjectId, name }`                                                                         |
| PATCH  | `/api/topics/:id`                                          | `{ name?, subjectId? }`                                                                       |
| DELETE | `/api/topics/:id`                                          | Its PDFs go to the trash.                                                                     |
| POST   | `/api/topics/reorder`                                      | `{ ids }` (all ids in the same subject).                                                      |
| GET    | `/api/documents/:id`                                       | `DocumentDetail`: summary + pageSizes + outline + lastScroll + subject/topic names.           |
| PATCH  | `/api/documents/:id`                                       | `{ title?, topicId? }`                                                                        |
| DELETE | `/api/documents/:id`                                       | Moves the document to the trash.                                                              |
| POST   | `/api/documents/reorder`                                   | `{ ids }` (same topic).                                                                       |
| PUT    | `/api/documents/:id/position`                              | `{ page, scroll 0–1, viewed?: number[], seconds?, day? }`. Records progress and reading time. |
| GET    | `/api/documents/:id/file`                                  | The PDF (private cache headers).                                                              |
| GET    | `/api/documents/:id/cover`                                 | WebP cover.                                                                                   |
| GET    | `/api/trash`                                               | `TrashedDocument[]`                                                                           |
| POST   | `/api/trash/:id/restore`                                   | `{ topicId }`                                                                                 |
| DELETE | `/api/trash/:id` · `/api/trash`                            | Purge one / empty the trash.                                                                  |
| GET    | `/api/search?q=&scope=doc\|topic\|subject\|all&id=&limit=` | `SearchHit[]`; snippets mark matches with `\u0002…\u0003`.                                    |
| GET    | `/api/pdfjs/:dir/:file`                                    | PDF.js data files (cmaps, standard_fonts, wasm, iccs) for the browser.                        |

## Uploads (chunked, resumable)

1. `POST /api/uploads` with `{ topicId, filename, size }` returns
   `{ id, size, received, chunkSize (32 MiB) }`. Returns 413 if `MAX_UPLOAD_MB`
   is exceeded.
2. `PUT /api/uploads/:id?offset=N`, `content-type: application/octet-stream`,
   with the raw chunk. The offset must equal `received`; otherwise the response
   is `409 { error:'offset_mismatch', received }`. The first chunk is checked
   for the `%PDF-` magic (415 `not_a_pdf`).
3. `GET /api/uploads/:id` returns the progress, for resuming.
4. `POST /api/uploads/:id/complete` returns `DocumentSummary` and queues
   ingestion. Returns 409 `upload_incomplete` if bytes are missing.
5. `DELETE /api/uploads/:id` cancels. Abandoned uploads are purged after 24 h.

`POST /api/documents/import-url` with `{ topicId, url }` returns
`DocumentSummary`. Possible errors: `url_not_allowed`, `invalid_url`,
`not_a_pdf`, `file_too_large`, `url_fetch_failed`, `url_timeout`.

## Chat threads

`:scope` is `documents`, `topics` or `subjects`.

| Method | Path                             | Notes                                                                                                               |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/:scope/:id/threads`        | `ThreadSummary[]`, most recent first.                                                                               |
| GET    | `/api/:scope/:id/threads/active` | The most recent thread, created if missing.                                                                         |
| POST   | `/api/:scope/:id/threads`        | New thread.                                                                                                         |
| GET    | `/api/threads/:id/messages`      | `{ running, messages: ChatMessage[] }`                                                                              |
| GET    | `/api/documents/:id/questions`   | `DocumentQuestion[]`: questions asked about a selection or drawn area, with the answer that followed, oldest first. |
| DELETE | `/api/threads/:id`               | 409 `busy` while a turn runs.                                                                                       |

## WebSocket `/ws/chat`

Same-origin check on the handshake. The server pings every 30 s. Types live in
`packages/shared/src/chat.ts`.

Client → server:

```jsonc
{ "type": "user_message", "threadId": "…", "clientId": "uuid", "text": "…",
  "mode": "free|eli5|summary|exam|relate",
  "context": { "docId": "…" /* or topicId / subjectId, exactly one */,
               "currentPage": 12, "selection": { "page": 12, "text": "…" },
               // Area marked with freehand drawings (document chats only). The server
               // renders it with the drawings on top and sends Claude the image.
               "mark": { "page": 12, "rect": { "x": 0.1, "y": 0.2, "w": 0.4, "h": 0.1 },
                         "annotationIds": ["…"], "text": "text inside the area" },
               "summaryFormat": "prose|outline|glossary" } }
{ "type": "stop", "threadId": "…" }
```

Server → client (`ServerChatEvent`):

- `user_message` (`clientId` + stored message)
- `assistant_start`
- `assistant_delta` (`text`)
- `tool_event` (`ToolEvent`: `name`, `summary`, `status`)
- `pointer` (`PointerGroup`: `messageId`, `docId`, `page`, `shapes`)
- `clear_pointers`
- `data_changed` (`scope`: `annotations` | `memory` | `flashcards`)
- `assistant_done` (the final stored message)
- `error` (`code`: `rate_limited` | `auth_expired` | `busy` | `internal`, plus an
  optional `messageId`)

## Annotations

| Method | Path                                  | Notes                                                                                                                    |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/documents/:id/annotations`      | Non-rejected `Annotation[]`.                                                                                             |
| POST   | `/api/documents/:id/annotations`      | `{ items: CreateAnnotation[], ids? }`. `ids` restores deleted ones (undo). Quote-only anchors get server-computed rects. |
| PATCH  | `/api/annotations/:id`                | `{ color?, content?, status?, anchor?, display? }` (`display`: note window, see DATA_MODEL)                              |
| POST   | `/api/annotations/status`             | `{ ids, status: active\|rejected\|proposed }` (accept or discard proposals).                                             |
| POST   | `/api/annotations/delete`             | `{ ids }`                                                                                                                |
| GET    | `/api/documents/:id/export-annotated` | Downloads a copy of the PDF with standard annotations.                                                                   |

## Diagrams

Mermaid schemas saved by Claude (`create_diagram` / `update_diagram`). Diagrams
of PDFs in the trash are hidden; purging a PDF deletes them.

| Method | Path                          | Notes                                 |
| ------ | ----------------------------- | ------------------------------------- |
| GET    | `/api/diagrams`               | `Diagram[]`, newest first (all PDFs). |
| GET    | `/api/documents/:id/diagrams` | `Diagram[]` of one PDF.               |
| GET    | `/api/diagrams/:id`           | `Diagram` (with `documentTitle`).     |
| PATCH  | `/api/diagrams/:id`           | `{ title }`                           |
| DELETE | `/api/diagrams/:id`           | 204.                                  |

The chat context also accepts `pageRange: { from, to }` (the scope of a diagram).

## Memory, review, stats, settings, backup

| Method | Path                                             | Notes                                                          |
| ------ | ------------------------------------------------ | -------------------------------------------------------------- |
| GET    | `/api/memory`                                    | `MemoryOverview` (read-only).                                  |
| GET    | `/api/flashcards?subjectId&topicId&documentId`   | Active and proposed cards.                                     |
| POST   | `/api/flashcards`                                | `{ cards: [{front, back, documentId?, page?}] }` (user cards). |
| PATCH  | `/api/flashcards/:id`                            | `{ front?, back?, status?: active\|rejected }`                 |
| DELETE | `/api/flashcards/:id`                            |                                                                |
| POST   | `/api/flashcards/:id/review`                     | `{ rating: 1..4, day: 'YYYY-MM-DD' }` → rescheduled card.      |
| GET    | `/api/review/queue?subjectId&topicId&documentId` | `ReviewQueue` (due cards, next intervals, proposals, total).   |
| GET    | `/api/review/today?day=`                         | `DailyBrief` (cached text for that day, or null).              |
| POST   | `/api/review/today?day=`                         | Generates the brief with Claude.                               |
| GET    | `/api/stats?day=`                                | `StudyStats`. `day` is the client's local day (streaks).       |
| GET    | `/api/settings`                                  | `{ palette, claudeModel }`                                     |
| PATCH  | `/api/settings`                                  | `{ palette?, claudeModel? }`                                   |
| GET    | `/api/backup`                                    | `pdfclaudeassistant-backup-YYYY-MM-DD.tar.gz`                  |

With `WEB_DIR` set, any other GET outside `/api` and `/ws` returns `index.html`
(SPA fallback), and unknown `/api/*` paths return `404 { error: 'not_found' }`.
