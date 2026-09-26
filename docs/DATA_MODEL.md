# Data model

SQLite (`DATA_DIR/pdfclaudeassistant.db`) through Drizzle ORM. Schema:
`apps/server/src/db/schema.ts`. Migrations: `apps/server/drizzle/`, applied
automatically on boot (`db/client.ts`) with WAL and `foreign_keys = ON`.

To change the schema:

1. Edit `schema.ts`.
2. Run `corepack pnpm --filter @pdfclaudeassistant/server db:generate` (or
   `npx drizzle-kit generate --name <name>` in `apps/server`).
3. Review the SQL. When `ALTER TABLE ADD COLUMN … REFERENCES` needs
   `ON DELETE cascade`, add it by hand (done in `0008`).
4. Commit the SQL and the `meta/` snapshot.

| Migration                 | Adds                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `0000_init`               | `settings`, `auth_sessions`                                                                      |
| `0001_library`            | `subjects`, `topics`, `documents`, `pages`                                                       |
| `0002_pages_fts`          | FTS5 `pages_fts` (external content, `unicode61 remove_diacritics 2`) + triggers                  |
| `0003_chat`               | `threads`, `messages`                                                                            |
| `0004_annotations`        | `annotations`                                                                                    |
| `0005_memory`             | `memory_items`, `concepts`, `exam_results`                                                       |
| `0006_study_sessions`     | `study_sessions`                                                                                 |
| `0007_flashcards`         | `flashcards`, `reviews`                                                                          |
| `0008_thread_scopes`      | `threads.topic_id`, `threads.subject_id` (cascade)                                               |
| `0009_annotation_display` | `annotations.display_json` (note window: pinned, position, size)                                 |
| `0010_diagrams`           | `diagrams`                                                                                       |
| `0011_focus_sessions`     | `focus_sessions`                                                                                 |
| `0012_users`              | `users`, `invitations`, `user_settings`; `user_id` on every owned table (hand-edited, see below) |

## Users and ownership (multi-user, `0012`)

- **users** `id, username (unique, lower case), display_name, password_hash
(argon2), role (admin|user), claude_token_enc (AES-256-GCM, key derived from
SESSION_SECRET, see services/secrets.ts), disabled_at, last_login_at`.
  The migration inserts the admin with the fixed id `owner` and username `admin`,
  and an empty password hash that `UserService.syncAdminPassword()` fills from
  `APP_PASSWORD_HASH` on boot (again whenever that variable changes; the applied
  hash is remembered in `settings.admin_password_env`).
- **invitations** `token_hash (SHA-256), note, created_by, expires_at (7 days),
used_at, used_by`.
- **user_settings** `(user_id, key) → value (JSON)`: what `settings` used to hold
  (`palette`, `claude_model`, `study_timer`, `daily_brief`). `settings` now keeps
  only server-wide values.
- `user_id` (FK users, cascade) on `auth_sessions`, `subjects`, `topics`,
  `documents`, `threads`, `annotations`, `memory_items`, `concepts`,
  `exam_results`, `study_sessions`, `flashcards`, `reviews`, `diagrams` and
  `focus_sessions`. Pages and messages are reached through their document/thread.
  Every service is built per user (`services/scope.ts`) and filters on it.
- To add the column to tables with rows, `0012` uses `DEFAULT 'owner'` (all
  existing data becomes the admin's). SQLite only allows a REFERENCES column with a
  default while foreign keys are off, so `openDb` migrates with them off and runs
  `foreign_key_check` afterwards. `schema.ts` declares no default, so TypeScript
  requires `userId` on every insert.
- Deleting a user cascades through all those tables; `UserService.delete` then
  removes their PDFs, covers and `claude-users/<id>/`.

## Tables (main columns)

- **settings** `key, value(JSON)`: server-wide, `admin_password_env`.
- **user_settings** `user_id, key, value(JSON)`: `palette`, `claude_model`,
  `study_timer`, `daily_brief` (`{day, text, generatedAt}`).
- **auth_sessions** stores only the SHA-256 of the cookie token, with
  last-seen and expiry (sliding 90 days).
- **subjects** `id, name, color, position` → **topics** `id, subject_id
(cascade), name, position`.
- **documents**:
  - identity and file: `id, topic_id (set null), title, file_path, file_size`;
  - `page_count, has_ocr, has_cover, status (queued|ocr|indexing|ready|error),
error, source_url, outline_json`;
  - reading position: `last_page, last_scroll, position, last_opened_at`;
  - trash: `deleted_at` (non-null = in the trash), `trashed_from_topic_id`.
- **pages** `document_id (cascade), page_number, width, height (PDF points),
text, text_layer_json, viewed_at`.
  - `text_layer_json` holds `[str, x, y, w, h]` items, normalised to 0–1 with a
    top-left origin.
  - It is used by the server-side quote anchoring and by
    `get_pages`/search.
  - Progress % = pages with `viewed_at` / page count.
- **threads** `id, document_id | topic_id | subject_id (exactly one, cascade),
claude_session_id, title (first question), updated_at`.
- **messages** `thread_id (cascade), role, content, context_json ({mode,
context}), tool_events_json, status (complete|interrupted|error), error_code`.
  `context.selection.rects` (normalised) places the question marks on the page.
  Order is `created_at, rowid`.
- **annotations**:
  - `document_id (cascade), page, type (highlight|note|drawing|shape),
author (user|claude), status (active|proposed|rejected)`;
  - `color`: a palette key, `claude` or a hex value;
  - `anchor_json` and `content` (note text, proposal reason, or mark label);
  - `display_json` (nullable): the note window's state, `{ pinned, x, y, w, h }`.
    `x, y` are the window's top-left corner in page space (null = next to the
    annotation); `w, h` are CSS pixels (null = default / fit the content).
- **diagrams** `document_id? (cascade), title, source (Mermaid), from_page?,
to_page?, updated_at`.
- **memory_items** `scope (global|document), document_id?, category, content`.
- **concepts** `name, key (canonical name for merging), document_id?, page?,
mastery 0–1, times_failed, last_evidence, last_seen_at`.
- **exam_results** `document_id?, question, user_answer, correct,
concepts_json`.
- **study_sessions** `document_id, day (local), seconds` (unique per doc+day).
- **focus_sessions** study-timer blocks: `id` (client-generated, so a block is recorded
  once), `document_id?` (set null on delete), `day (local), seconds, completed, method`.
  User settings key `study_timer` holds the timer options.
- **flashcards**:
  - content and links: `document_id?, page?, concept_id?, front, back`;
  - `author, status (active|proposed|rejected)`;
  - scheduling: `fsrs_json` (ts-fsrs Card) and `due_at`.
- **reviews** `flashcard_id (cascade), rating 1–4, reviewed_at, day (local)`.

## Anchors (normalised page space, 0–1, top-left)

Shared schemas are in `packages/shared/src/annotations.ts` and `chat.ts`.

- highlight: `{ quote?, rects?: NormRect[] }`. Browser-made highlights send the
  selection rects. Claude's proposals send a quote, and the server fills in the
  rects.
- note: `{ kind: 'point', x, y }` or `{ kind: 'text', quote?, rects? }`.
- drawing: `{ strokes: [{ points: [x, y, pressure][], width (fraction of page
width), color }] }`.
- shape (a saved Claude mark): `{ shape: arrow|circle|rect|highlight|label,
rects?, quote? }`.
- pointer (ephemeral, WS only): `{ kind:'text', quote, occurrence? }` or
  `{ kind:'rect', x, y, w, h }`.

## Files under `DATA_DIR`

```
pdfclaudeassistant.db (+ -wal/-shm)
pdfs/<id>.pdf           served file (OCR'd copy if OCR ran)
pdfs/<id>.orig.pdf      original before OCR (only if OCR ran)
covers/<id>.webp
uploads/<id>.json|.part in-progress chunked uploads (purged after 24 h)
agent-cwd/              empty cwd for Claude Code
claude-home/            Claude Code config/session of the admin (CLAUDE_CONFIG_DIR). Never backed up.
claude-users/<userId>/  Claude Code config/sessions of every other user. Never backed up.
backups/                output of `node dist/backup.js`
```

Locally, the owner's `.env` sets `DATA_DIR=../../data` (the repo's `data/`,
which is gitignored and contains his real PDFs; don't touch it).
