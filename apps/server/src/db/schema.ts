import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

/** Server-wide values (not per user), e.g. which APP_PASSWORD_HASH was last applied. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * Accounts (multi-user). The admin is the server owner: the account the migration
 * created for the pre-existing data, whose password comes from APP_PASSWORD_HASH and
 * who alone may use the server's own Claude credentials. Everyone else brings their
 * own Claude token, stored encrypted.
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  /** Lower-case login name. */
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] })
    .notNull()
    .default('user'),
  /** AES-256-GCM encrypted CLAUDE_CODE_OAUTH_TOKEN (see services/secrets.ts). */
  claudeTokenEnc: text('claude_token_enc'),
  disabledAt: text('disabled_at'),
  lastLoginAt: text('last_login_at'),
  createdAt: createdAt(),
});

/** Single-use sign-up links created by the admin; only a SHA-256 of the token is stored. */
export const invitations = sqliteTable('invitations', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  /** Free text to remember who the link is for. */
  note: text('note'),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  usedBy: text('used_by').references(() => users.id, { onDelete: 'set null' }),
});

/**
 * Owner of a row. Existing rows were given to the admin by migration 0012 (the column
 * has that id as its database default only so the migration could add it).
 */
const userId = () =>
  text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

/** Per-user settings as JSON values (palette, model, study timer, daily brief). */
export const userSettings = sqliteTable(
  'user_settings',
  {
    userId: userId(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** Login sessions; only a SHA-256 of the cookie token is stored. */
export const authSessions = sqliteTable('auth_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: userId(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  lastSeenAt: text('last_seen_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  userAgent: text('user_agent'),
});

export const subjects = sqliteTable(
  'subjects',
  {
    id: text('id').primaryKey(),
    userId: userId(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    position: integer('position').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('subjects_user_idx').on(t.userId, t.position)],
);

export const topics = sqliteTable(
  'topics',
  {
    id: text('id').primaryKey(),
    userId: userId(),
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
    userId: userId(),
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
    index('documents_user_idx').on(t.userId, t.lastOpenedAt),
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
    userId: userId(),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    /** Topic or subject threads (F-CHAT-08) ask about several PDFs at once. */
    topicId: text('topic_id').references(() => topics.id, { onDelete: 'cascade' }),
    subjectId: text('subject_id').references(() => subjects.id, { onDelete: 'cascade' }),
    claudeSessionId: text('claude_session_id'),
    title: text('title'),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('threads_document_idx').on(t.documentId, t.updatedAt),
    index('threads_topic_idx').on(t.topicId, t.updatedAt),
    index('threads_subject_idx').on(t.subjectId, t.updatedAt),
  ],
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
    userId: userId(),
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
    /** Note window state (pinned, moved, resized) as JSON; null = defaults. */
    displayJson: text('display_json'),
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
    userId: userId(),
    scope: text('scope', { enum: ['global', 'document'] }).notNull(),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    content: text('content').notNull(),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('memory_scope_idx').on(t.userId, t.scope, t.documentId)],
);

/** Concepts the student finds hard, with a 0–1 mastery level (F-MEM-03). */
export const concepts = sqliteTable(
  'concepts',
  {
    id: text('id').primaryKey(),
    userId: userId(),
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
  (t) => [index('concepts_key_idx').on(t.userId, t.key)],
);

/** Exam answers evaluated by Claude (F-CHAT-03 exam mode, statistics). */
export const examResults = sqliteTable(
  'exam_results',
  {
    id: text('id').primaryKey(),
    userId: userId(),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    userAnswer: text('user_answer').notNull(),
    correct: integer('correct', { mode: 'boolean' }).notNull(),
    conceptsJson: text('concepts_json').notNull().default('[]'),
    createdAt: createdAt(),
  },
  (t) => [
    index('exam_results_document_idx').on(t.documentId, t.createdAt),
    index('exam_results_user_idx').on(t.userId),
  ],
);

/** Reading time per document and day (F-VIS-05, statistics). */
export const studySessions = sqliteTable(
  'study_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: userId(),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    /** Local calendar day, YYYY-MM-DD. */
    day: text('day').notNull(),
    seconds: integer('seconds').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('study_sessions_doc_day_idx').on(t.documentId, t.day),
    index('study_sessions_user_idx').on(t.userId, t.day),
  ],
);

/** Flashcards with FSRS scheduling state (F-REV-01/02). */
export const flashcards = sqliteTable(
  'flashcards',
  {
    id: text('id').primaryKey(),
    userId: userId(),
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
  (t) => [index('flashcards_due_idx').on(t.userId, t.status, t.dueAt)],
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: userId(),
    flashcardId: text('flashcard_id')
      .notNull()
      .references(() => flashcards.id, { onDelete: 'cascade' }),
    /** 1 again, 2 hard, 3 good, 4 easy. */
    rating: integer('rating').notNull(),
    reviewedAt: text('reviewed_at').notNull(),
    /** Local calendar day, for streaks. */
    day: text('day').notNull(),
  },
  (t) => [index('reviews_day_idx').on(t.userId, t.day)],
);

/** Visual schemas drawn by Claude (Mermaid source), listed per PDF and on "Esquemas". */
export const diagrams = sqliteTable(
  'diagrams',
  {
    id: text('id').primaryKey(),
    userId: userId(),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    source: text('source').notNull(),
    fromPage: integer('from_page'),
    toPage: integer('to_page'),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('diagrams_document_idx').on(t.documentId, t.createdAt),
    index('diagrams_user_idx').on(t.userId, t.updatedAt),
  ],
);

/** Study-timer focus blocks (F-FOCUS-02); kept when the PDF is deleted. */
export const focusSessions = sqliteTable(
  'focus_sessions',
  {
    /** Client-generated block id, so recording the same block twice is a no-op. */
    id: text('id').primaryKey(),
    userId: userId(),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'set null' }),
    /** Local calendar day, YYYY-MM-DD. */
    day: text('day').notNull(),
    seconds: integer('seconds').notNull(),
    completed: integer('completed', { mode: 'boolean' }).notNull(),
    method: text('method').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('focus_sessions_day_idx').on(t.userId, t.day)],
);
