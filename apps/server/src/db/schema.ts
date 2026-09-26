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

/**
 * Permanent annotations (F-ANN-*): highlights, notes, freehand drawings and saved
 * Claude marks. Anchors live in normalised page space (0–1, top-left origin).
 */
export const annotations = sqliteTable(
  'annotations',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    page: integer('page').notNull(),
    type: text('type', { enum: ['highlight', 'note', 'drawing', 'shape'] }).notNull(),
    author: text('author', { enum: ['user', 'claude'] }).notNull(),
    status: text('status', { enum: ['active', 'proposed', 'rejected'] })
      .notNull()
      .default('active'),
    /** Palette key (yellow, green, blue, red, purple, claude) or a hex colour. */
    color: text('color').notNull(),
    anchorJson: text('anchor_json').notNull(),
    /** Note text, Claude's reason for a proposed highlight or a mark's label. */
    content: text('content'),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('annotations_document_idx').on(t.documentId, t.page)],
);

/** Distilled memory written by Claude through tools (F-MEM-01/02/04). */
export const memoryItems = sqliteTable(
  'memory_items',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['global', 'document'] }).notNull(),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    content: text('content').notNull(),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('memory_scope_idx').on(t.scope, t.documentId)],
);

/** Concepts the student finds hard, with a 0–1 mastery level (F-MEM-03). */
export const concepts = sqliteTable(
  'concepts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Lower-cased, accent-free name used to merge duplicates. */
    key: text('key').notNull(),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'set null' }),
    page: integer('page'),
    mastery: real('mastery').notNull().default(0.3),
    timesFailed: integer('times_failed').notNull().default(0),
    lastEvidence: text('last_evidence'),
    lastSeenAt: text('last_seen_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('concepts_key_idx').on(t.key)],
);

/** Exam answers evaluated by Claude (F-CHAT-03 exam mode, statistics). */
export const examResults = sqliteTable(
  'exam_results',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    userAnswer: text('user_answer').notNull(),
    correct: integer('correct', { mode: 'boolean' }).notNull(),
    conceptsJson: text('concepts_json').notNull().default('[]'),
    createdAt: createdAt(),
  },
  (t) => [index('exam_results_document_idx').on(t.documentId, t.createdAt)],
);

/** Reading time per document and day (F-VIS-05, statistics). */
export const studySessions = sqliteTable(
  'study_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    /** Local calendar day, YYYY-MM-DD. */
    day: text('day').notNull(),
    seconds: integer('seconds').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('study_sessions_doc_day_idx').on(t.documentId, t.day)],
);

/** Flashcards with FSRS scheduling state (F-REV-01/02). */
export const flashcards = sqliteTable(
  'flashcards',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'set null' }),
    page: integer('page'),
    conceptId: text('concept_id').references(() => concepts.id, { onDelete: 'set null' }),
    front: text('front').notNull(),
    back: text('back').notNull(),
    author: text('author', { enum: ['user', 'claude'] }).notNull(),
    status: text('status', { enum: ['active', 'proposed', 'rejected'] })
      .notNull()
      .default('active'),
    /** ts-fsrs Card, JSON (dates as ISO strings). */
    fsrsJson: text('fsrs_json').notNull(),
    dueAt: text('due_at').notNull(),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('flashcards_due_idx').on(t.status, t.dueAt)],
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    flashcardId: text('flashcard_id')
      .notNull()
      .references(() => flashcards.id, { onDelete: 'cascade' }),
    /** 1 again, 2 hard, 3 good, 4 easy. */
    rating: integer('rating').notNull(),
    reviewedAt: text('reviewed_at').notNull(),
    /** Local calendar day, for streaks. */
    day: text('day').notNull(),
  },
  (t) => [index('reviews_day_idx').on(t.day)],
);
