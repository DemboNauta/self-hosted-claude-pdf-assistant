import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** Login sessions for the single user; only a SHA-256 of the cookie token is stored. */
export const authSessions = sqliteTable('auth_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  lastSeenAt: text('last_seen_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  userAgent: text('user_agent'),
});

export const subjects = sqliteTable('subjects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  position: integer('position').notNull(),
  createdAt: createdAt(),
});

export const topics = sqliteTable(
  'topics',
  {
    id: text('id').primaryKey(),
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('topics_subject_idx').on(t.subjectId)],
);

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    /** Null only while in the trash after its topic was deleted. */
    topicId: text('topic_id').references(() => topics.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    filePath: text('file_path').notNull(),
    fileSize: integer('file_size').notNull(),
    pageCount: integer('page_count'),
    hasOcr: integer('has_ocr', { mode: 'boolean' }).notNull().default(false),
    hasCover: integer('has_cover', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['queued', 'ocr', 'indexing', 'ready', 'error'] })
      .notNull()
      .default('queued'),
    error: text('error'),
    sourceUrl: text('source_url'),
    outlineJson: text('outline_json'),
    lastPage: integer('last_page').notNull().default(1),
    lastScroll: real('last_scroll').notNull().default(0),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    lastOpenedAt: text('last_opened_at'),
    deletedAt: text('deleted_at'),
    /** Topic the document was in when trashed; plain column (no FK) so it survives topic deletion. */
    trashedFromTopicId: text('trashed_from_topic_id'),
  },
  (t) => [
    index('documents_topic_idx').on(t.topicId),
    index('documents_deleted_idx').on(t.deletedAt),
  ],
);

export const pages = sqliteTable(
  'pages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(),
    width: real('width').notNull(),
    height: real('height').notNull(),
    text: text('text').notNull(),
    /** Compact text items: [str, x, y, w, h] with coordinates normalised to 0–1 (top-left origin). */
    textLayerJson: text('text_layer_json').notNull(),
    viewedAt: text('viewed_at'),
  },
  (t) => [uniqueIndex('pages_document_page_idx').on(t.documentId, t.pageNumber)],
);

/**
 * Chat threads (F-CHAT-07). One Claude Code session per thread, resumed with
 * `claude_session_id`. Phase 1 threads belong to a document; topic/subject threads
 * (F-CHAT-08) come later.
 */
export const threads = sqliteTable(
  'threads',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    claudeSessionId: text('claude_session_id'),
    title: text('title'),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('threads_document_idx').on(t.documentId, t.updatedAt)],
);

/** Chat history kept for consultation; long-term memory is the distilled one (F-MEM-06). */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    /** User turns: mode, page and selection sent with the question. */
    contextJson: text('context_json'),
    /** Assistant turns: tools Claude used while answering. */
    toolEventsJson: text('tool_events_json'),
    status: text('status', { enum: ['complete', 'interrupted', 'error'] })
      .notNull()
      .default('complete'),
    errorCode: text('error_code'),
    createdAt: createdAt(),
  },
  (t) => [index('messages_thread_idx').on(t.threadId, t.createdAt)],
);
