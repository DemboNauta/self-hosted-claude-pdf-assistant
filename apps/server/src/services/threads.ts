import type {
  ChatContext,
  ChatErrorCode,
  ChatMessage,
  DocumentQuestion,
  StudyMode,
  ThreadScope,
  ThreadSummary,
  ToolEvent,
} from '@pdfclaudeassistant/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { messages, threads } from '../db/schema.js';
import { pageItems, quoteRects } from './anchoring.js';
import { notFound } from './errors.js';
import { newId } from './ids.js';

type ThreadRow = typeof threads.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

interface StoredContext {
  mode: StudyMode;
  context: ChatContext;
}

const now = () => new Date().toISOString();

function toMessage(row: MessageRow): ChatMessage {
  const ctx = row.contextJson ? (JSON.parse(row.contextJson) as StoredContext) : null;
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    ...(ctx ? { mode: ctx.mode, context: ctx.context } : {}),
    ...(row.toolEventsJson ? { toolEvents: JSON.parse(row.toolEventsJson) as ToolEvent[] } : {}),
    status: row.status,
    errorCode: (row.errorCode as ChatErrorCode | null) ?? null,
    createdAt: row.createdAt,
  };
}

const scopeColumn = (kind: ThreadScope['kind']) =>
  kind === 'document' ? threads.documentId : kind === 'topic' ? threads.topicId : threads.subjectId;

/** The scope a stored thread belongs to. */
export function scopeOf(row: ThreadRow): ThreadScope {
  if (row.documentId) return { kind: 'document', id: row.documentId };
  if (row.topicId) return { kind: 'topic', id: row.topicId };
  return { kind: 'subject', id: row.subjectId ?? '' };
}

/** Chat threads and their messages (F-CHAT-07/08). */
export class ThreadService {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  list(scope: ThreadScope): ThreadSummary[] {
    return this.db
      .select({
        id: threads.id,
        documentId: threads.documentId,
        topicId: threads.topicId,
        subjectId: threads.subjectId,
        title: threads.title,
        createdAt: threads.createdAt,
        updatedAt: threads.updatedAt,
        messageCount: sql<number>`(SELECT count(*) FROM messages m WHERE m.thread_id = threads.id)`,
      })
      .from(threads)
      .where(and(eq(threads.userId, this.userId), eq(scopeColumn(scope.kind), scope.id)))
      .orderBy(desc(threads.updatedAt))
      .all();
  }

  create(scope: ThreadScope): ThreadSummary {
    const row = {
      id: newId(),
      userId: this.userId,
      documentId: scope.kind === 'document' ? scope.id : null,
      topicId: scope.kind === 'topic' ? scope.id : null,
      subjectId: scope.kind === 'subject' ? scope.id : null,
      updatedAt: now(),
    };
    this.db.insert(threads).values(row).run();
    const { userId: _owner, ...summary } = row;
    return { ...summary, title: null, createdAt: row.updatedAt, messageCount: 0 };
  }

  /** The scope's active thread: the most recently used one, created if missing. */
  active(scope: ThreadScope): ThreadSummary {
    return this.list(scope)[0] ?? this.create(scope);
  }

  get(id: string): ThreadRow {
    const row = this.db.select().from(threads).where(this.own(id)).get();
    if (!row) throw notFound();
    return row;
  }

  delete(id: string) {
    const res = this.db.delete(threads).where(this.own(id)).run();
    if (res.changes === 0) throw notFound();
  }

  messages(threadId: string, limit = 500): ChatMessage[] {
    this.get(threadId);
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.createdAt), asc(sql`rowid`))
      .limit(limit)
      .all()
      .map(toMessage);
  }

  /** Last messages as plain text, used to rebuild context if a Claude session is lost. */
  recentTranscript(threadId: string, maxChars = 12_000): string {
    const rows = this.db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.status, 'complete')))
      .orderBy(desc(messages.createdAt), desc(sql`rowid`))
      .limit(20)
      .all();
    let out = '';
    for (const r of rows) {
      const line = `${r.role === 'user' ? 'Estudiante' : 'Tutor'}: ${r.content}\n\n`;
      if (out.length + line.length > maxChars) break;
      out = line + out;
    }
    return out.trim();
  }

  addUserMessage(threadId: string, text: string, mode: StudyMode, context: ChatContext) {
    const row = {
      id: newId(),
      threadId,
      role: 'user' as const,
      content: text,
      contextJson: JSON.stringify({ mode, context } satisfies StoredContext),
    };
    this.db.insert(messages).values(row).run();
    const thread = this.get(threadId);
    this.db
      .update(threads)
      .set({
        updatedAt: now(),
        // First question names the thread.
        ...(thread.title ? {} : { title: titleFrom(text || context.selection?.text || '') }),
      })
      .where(eq(threads.id, threadId))
      .run();
    return toMessage(this.getMessage(row.id));
  }

  addAssistantMessage(threadId: string): ChatMessage {
    const id = newId();
    this.db.insert(messages).values({ id, threadId, role: 'assistant', content: '' }).run();
    return { ...toMessage(this.getMessage(id)), status: 'streaming' };
  }

  finishAssistantMessage(
    id: string,
    patch: {
      content: string;
      toolEvents: ToolEvent[];
      status: 'complete' | 'interrupted' | 'error';
      errorCode?: ChatErrorCode;
    },
  ): ChatMessage {
    this.db
      .update(messages)
      .set({
        content: patch.content,
        toolEventsJson: patch.toolEvents.length ? JSON.stringify(patch.toolEvents) : null,
        status: patch.status,
        errorCode: patch.errorCode ?? null,
      })
      .where(eq(messages.id, id))
      .run();
    const row = this.getMessage(id);
    this.db.update(threads).set({ updatedAt: now() }).where(eq(threads.id, row.threadId)).run();
    return toMessage(row);
  }

  /**
   * Questions asked about a passage of the document (selection or drawing mark), with
   * the answer that followed each one, across all its threads, oldest first.
   */
  documentQuestions(documentId: string): DocumentQuestion[] {
    const rows = this.db
      .select({ message: messages })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(and(eq(threads.userId, this.userId), eq(threads.documentId, documentId)))
      .orderBy(asc(messages.threadId), asc(messages.createdAt), asc(sql`messages.rowid`))
      .all()
      .map((r) => toMessage(r.message));
    const items = new Map<number, ReturnType<typeof pageItems>>();
    const locate = (page: number, quote: string) => {
      if (!items.has(page)) items.set(page, pageItems(this.db, documentId, page));
      return quoteRects(items.get(page) ?? [], quote);
    };
    const out: DocumentQuestion[] = [];
    rows.forEach((m, i) => {
      const { selection, mark } = m.context ?? {};
      if (m.role !== 'user' || (!selection && !mark)) return;
      const next = rows[i + 1];
      const answer = next?.threadId === m.threadId && next.role === 'assistant' ? next : null;
      out.push({
        id: m.id,
        threadId: m.threadId,
        ...(selection
          ? {
              kind: 'selection' as const,
              page: selection.page,
              quote: selection.text,
              rects: selection.rects?.length
                ? selection.rects
                : locate(selection.page, selection.text),
            }
          : { kind: 'mark' as const, page: mark!.page, quote: mark!.text, rects: [mark!.rect] }),
        mode: m.mode ?? 'free',
        question: m.content,
        answer: answer?.content || null,
        answerStatus: answer?.status ?? null,
        createdAt: m.createdAt,
      });
    });
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  setClaudeSession(threadId: string, sessionId: string | null) {
    this.db
      .update(threads)
      .set({ claudeSessionId: sessionId })
      .where(eq(threads.id, threadId))
      .run();
  }

  private own(id: string) {
    return and(eq(threads.id, id), eq(threads.userId, this.userId));
  }

  private getMessage(id: string): MessageRow {
    const row = this.db.select().from(messages).where(eq(messages.id, id)).get();
    if (!row) throw notFound();
    return row;
  }
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine || 'Conversación';
}
