# Feature status (SPEC §3 IDs)

✅ done and tested · 🟡 partial · ⬜ not started. "e2e" = covered by a Playwright
spec in `apps/web/e2e`. "fake" = tested only against the fake Claude of the e2e
server, not against real Claude yet.

## 3.1 Library

| ID       | Status | Where / notes                                                                                  |
| -------- | ------ | ---------------------------------------------------------------------------------------------- |
| F-LIB-01 | ✅     | `features/library/SubjectTree.tsx`, dnd-kit (pointer, touch, keyboard). e2e `library.spec.ts`. |
| F-LIB-02 | ✅     | Move via card menu or by dragging a card onto a topic.                                         |
| F-LIB-03 | ✅     | `DocumentCard.tsx`: cover, pages, % read, last access.                                         |
| F-LIB-04 | ✅     | Position saved while scrolling (`PUT /documents/:id/position`) and restored.                   |
| F-LIB-05 | ✅     | 30-day trash, restore into a chosen topic, purge one or empty all (`TrashPage.tsx`).           |

## 3.2 Ingestion

| ID       | Status | Where / notes                                                                                                          |
| -------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| F-ING-01 | ✅     | Chunked resumable uploads (`services/uploads.ts`, `features/library/uploads.ts`), drag & drop.                         |
| F-ING-02 | ✅     | `POST /documents/import-url`, SSRF-safe (`services/url-import.ts`).                                                    |
| F-ING-03 | 🟡     | `ingest/ocr.ts` with ocrmypdf `--skip-text`. Tested with a fake runner; real ocrmypdf exists only in the Docker image. |
| F-ING-04 | ✅     | Worker-thread PDF.js extraction: per-page text, normalised items, sizes, outline, cover, FTS5.                         |
| F-ING-05 | ✅     | Status: queued → ocr → indexing → ready/error. The UI polls while processing.                                          |

## 3.3 Viewer

| ID       | Status | Where / notes                                                                                   |
| -------- | ------ | ----------------------------------------------------------------------------------------------- |
| F-VIS-01 | ✅     | `PdfViewer.tsx` (virtualised ±2 pages), zoom (buttons, ctrl+wheel, pinch), thumbnails, outline. |
| F-VIS-02 | ✅     | Search panel on FTS5, highlights on the page.                                                   |
| F-VIS-03 | ✅     | Citation chips jump and flash the quote (`PdfPage.tsx` Highlights).                             |
| F-VIS-04 | ✅     | Dark PDF canvas toggle in Settings (`lib/theme.ts`, CSS filter).                                |
| F-VIS-05 | ✅     | Viewed pages → progress. Active reading time → `study_sessions`.                                |

## 3.4 Conversation with Claude

| ID        | Status  | Where / notes                                                                                                                                                                                                           |
| --------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-CHAT-01 | ✅      | `ChatDock.tsx`: resizable right panel on desktop, bottom sheet on mobile.                                                                                                                                               |
| F-CHAT-02 | ✅      | `SelectionMenu.tsx`: ask, explain simply, summarise, question me, flashcard, colours, note.                                                                                                                             |
| F-CHAT-03 | 🟡      | All modes in `claude/prompt.ts`; summary formats. Exam mode records results. Only free mode was tried with real Claude.                                                                                                 |
| F-CHAT-04 | ✅      | `[[cite:docId:page\|"quote"]]` → chips (`Markdown.tsx`, `CitationChip.tsx`).                                                                                                                                            |
| F-CHAT-05 | ✅      | Streaming Markdown + GFM + KaTeX + code.                                                                                                                                                                                |
| F-CHAT-06 | 🟡      | Web Speech API mic button. Not testable in CI; needs a check on real devices.                                                                                                                                           |
| F-CHAT-07 | ✅      | Threads per document, history menu, new thread.                                                                                                                                                                         |
| (extra)   | ✅ fake | Question marks (owner request 2026-09-26): asking about a selection or drawn area leaves a margin badge on the page; it opens the questions and Claude's answers (`QuestionMarks.tsx`, `GET /documents/:id/questions`). |
| F-CHAT-08 | ✅ fake | Topic/subject chats (`ScopeChatPage.tsx`).                                                                                                                                                                              |

## 3.5 Marks

| ID         | Status  | Where / notes                                                                                                     |
| ---------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| F-POINT-01 | ✅      | `point_at` tool → `PointerLayer.tsx` (arrow, circle, rect, highlight, label). Tried with real Claude.             |
| F-POINT-02 | ✅      | Animated in, grouped per answer.                                                                                  |
| F-POINT-03 | ✅      | Cleared with the next question or "Limpiar".                                                                      |
| F-POINT-04 | ✅      | "Guardar" in the chat → `shape` annotations.                                                                      |
| F-POINT-05 | ✅      | The viewer jumps to the page (provisional choice).                                                                |
| F-ANN-01   | ✅      | 5 colours with editable meanings.                                                                                 |
| F-ANN-02   | ✅      | Point notes (movable) and text-anchored notes. Note window: resizable, movable, pinnable, bottom sheet on phones. |
| F-ANN-03   | ✅      | Freehand pen (pressure), eraser, movable drawings; "Preguntar" sends the marked area (text + image) to Claude.    |
| F-ANN-04   | ✅ fake | `highlight_key_ideas` proposals, accept or discard one by one or in bulk.                                         |
| F-ANN-05   | ✅      | Layer toggle, filters by author and colour.                                                                       |
| F-ANN-06   | ✅      | `GET /documents/:id/export-annotated` (pdf-lib, standard annotations).                                            |
| F-ANN-07   | ✅      | `AnnotationsPanel.tsx`.                                                                                           |
| F-ANN-08   | ✅      | Undo/redo stack (`features/annotations/api.ts`), Ctrl+Z / Ctrl+Shift+Z.                                           |

## 3.6 Memory

| ID           | Status  | Where / notes                                                         |
| ------------ | ------- | --------------------------------------------------------------------- |
| F-MEM-01..04 | ✅ fake | `services/memory.ts`, memory tools, injected per turn (`contextFor`). |
| F-MEM-05     | ✅      | `/memory` page and a reader side panel (read-only).                   |
| F-MEM-06     | ✅      | Chats are stored as history only. Memory is the distilled items.      |

## 3.7 Review

| ID       | Status  | Where / notes                                                                  |
| -------- | ------- | ------------------------------------------------------------------------------ |
| F-REV-01 | ✅      | Cards from a selection, and Claude proposals (`create_flashcards`, fake only). |
| F-REV-02 | ✅      | ts-fsrs, 4 ratings with interval preview (`services/review.ts`).               |
| F-REV-03 | ✅ fake | Home "Repaso de hoy" (`services/brief.ts`).                                    |
| F-REV-04 | ✅      | `/stats` (`services/stats.ts`).                                                |
| F-REV-05 | ✅      | Filter by subject or topic.                                                    |

## 3.8 Search

| ID       | Status | Where / notes                                  |
| -------- | ------ | ---------------------------------------------- |
| F-SRC-01 | ✅     | `/search` page.                                |
| F-SRC-02 | ✅     | Subject/topic filter.                          |
| F-SRC-03 | ✅     | `search_library` tool (doc/topic/subject/all). |
| F-SRC-04 | ⬜     | Phase 4, not planned yet (decision #4).        |

## 3.9 General UX

| ID      | Status | Where / notes                                                                  |
| ------- | ------ | ------------------------------------------------------------------------------ |
| F-UX-01 | ✅     | Desktop, tablet and phone layouts; e2e runs on desktop and Pixel 7.            |
| F-UX-02 | ✅     | Light, dark and system themes.                                                 |
| F-UX-03 | ✅     | Reader and review shortcuts, "?" help, list in Settings.                       |
| F-UX-04 | ✅     | Argon2 password, 90-day sliding session, rate limit. Now per user (see below). |
| F-UX-05 | ✅     | Manifest, icons, service worker (production only).                             |

## Beyond the SPEC (owner requests)

| Feature        | Status  | Where / notes                                                                                                                                                                                                                                                                                                             |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visual schemas | ✅ fake | "Esquema visual" chat mode (whole PDF or pages) and selection action; Claude picks mind map / tree / flowchart (Mermaid, `features/diagrams`). Shown in the chat, the reader's "Esquemas" panel and the `/diagrams` page; full-screen canvas with free zoom and pan (wheel, drag, pinch). Not yet tried with real Claude. |
| Study timer    | ✅      | F-FOCUS-01..03 (`features/timer`): floating, draggable widget on every page (sidebar, reader toolbar, phone page headers). Pomodoro 25/5 (long 15 every 4), 50/10, 52/17, 90/20 and custom. Chime, break screen, completed blocks in the stats.                                                                           |

| Multi-user | ✅ | Accounts with username + password; the admin (the server owner, who keeps the pre-existing data) creates accounts or single-use invitation links (`/admin`, `/invite/:token`). Every user's data is isolated; each connects their own Claude token in Settings (encrypted). Account settings: name, username, password. Server tests `test/users.test.ts`, e2e `users.spec.ts`. |

## SPEC §11–12 (ops/security)

| Item                                   | Status | Notes                                                    |
| -------------------------------------- | ------ | -------------------------------------------------------- |
| Backup script + Settings button        | ✅     | `GET /api/backup`, `node dist/backup.js`.                |
| Server serves web, loopback port       | ✅     | See `DEPLOYMENT.md`.                                     |
| deploy.ps1, host Caddy snippet, README | ⬜     | Next step.                                               |
| Prompt-injection rule                  | ✅     | System prompt: document text is data.                    |
| SSRF protection for URL import         | ✅     | Private ranges refused at connect time and on redirects. |
| No API key anywhere                    | ✅     | Startup guard + filtered agent env + repo scan test.     |
