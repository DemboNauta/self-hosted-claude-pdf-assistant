import fs from 'node:fs';
import path from 'node:path';
import type {
  CreateSubject,
  CreateTopic,
  DocumentDetail,
  DocumentSummary,
  LibraryTree,
  OutlineEntry,
  ReadingPosition,
  SubjectNode,
  TrashedDocument,
  UpdateDocument,
  UpdateSubject,
  UpdateTopic,
} from '@pdfclaudeassistant/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { documents, pages, studySessions, subjects, topics } from '../db/schema.js';
import { HttpError, notFound } from './errors.js';
import { newId } from './ids.js';

export const TRASH_RETENTION_DAYS = 30;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Default subject colours, cycled on creation. */
const SUBJECT_COLORS = ['#4f6d7a', '#8a5a44', '#5b7553', '#7a5c8a', '#a0793d', '#46707a'];

type DocumentRow = typeof documents.$inferSelect;

export class LibraryService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  // ---- tree -------------------------------------------------------------

  tree(): LibraryTree {
    const subjectRows = this.db.select().from(subjects).orderBy(asc(subjects.position)).all();
    const topicRows = this.db.select().from(topics).orderBy(asc(topics.position)).all();
    const docRows = this.db
      .select()
      .from(documents)
      .where(isNull(documents.deletedAt))
      .orderBy(asc(documents.position), asc(documents.createdAt))
      .all();
    const viewed = this.viewedCounts(docRows.map((d) => d.id));

    const byTopic = new Map<string, DocumentSummary[]>();
    for (const d of docRows) {
      if (!d.topicId) continue;
      const list = byTopic.get(d.topicId) ?? [];
      list.push(toSummary(d, viewed.get(d.id) ?? 0));
      byTopic.set(d.topicId, list);
    }
    const bySubject = new Map<string, SubjectNode['topics']>();
    for (const t of topicRows) {
      const list = bySubject.get(t.subjectId) ?? [];
      list.push({
        id: t.id,
        subjectId: t.subjectId,
        name: t.name,
        position: t.position,
        documents: byTopic.get(t.id) ?? [],
      });
      bySubject.set(t.subjectId, list);
    }
    return {
      subjects: subjectRows.map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        position: s.position,
        topics: bySubject.get(s.id) ?? [],
      })),
    };
  }

  // ---- subjects ---------------------------------------------------------

  createSubject(input: CreateSubject) {
    const count =
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(subjects)
        .get()?.n ?? 0;
    const row = {
      id: newId(),
      name: input.name,
      color: input.color ?? SUBJECT_COLORS[count % SUBJECT_COLORS.length]!,
      position: this.nextPosition(subjects.position, subjects),
    };
    this.db.insert(subjects).values(row).run();
    return row;
  }

  updateSubject(id: string, input: UpdateSubject) {
    const res = this.db.update(subjects).set(input).where(eq(subjects.id, id)).run();
    if (res.changes === 0) throw notFound();
  }

  /** Deletes a subject and its topics; their documents go to the trash (owner decision). */
  deleteSubject(id: string) {
    this.db.transaction((tx) => {
      const topicIds = tx
        .select({ id: topics.id })
        .from(topics)
        .where(eq(topics.subjectId, id))
        .all()
        .map((t) => t.id);
      if (topicIds.length) this.trashDocumentsOfTopics(tx, topicIds);
      const res = tx.delete(subjects).where(eq(subjects.id, id)).run();
      if (res.changes === 0) throw notFound();
    });
  }

  reorderSubjects(ids: string[]) {
    this.db.transaction((tx) => {
      ids.forEach((id, position) =>
        tx.update(subjects).set({ position }).where(eq(subjects.id, id)).run(),
      );
    });
  }

  // ---- topics -----------------------------------------------------------

  createTopic(input: CreateTopic) {
    this.requireSubject(input.subjectId);
    const row = {
      id: newId(),
      subjectId: input.subjectId,
      name: input.name,
      position: this.nextPosition(topics.position, topics, eq(topics.subjectId, input.subjectId)),
    };
    this.db.insert(topics).values(row).run();
    return row;
  }

  updateTopic(id: string, input: UpdateTopic) {
    const patch: Partial<typeof topics.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.subjectId !== undefined) {
      this.requireSubject(input.subjectId);
      patch.subjectId = input.subjectId;
      patch.position = this.nextPosition(
        topics.position,
        topics,
        eq(topics.subjectId, input.subjectId),
      );
    }
    if (Object.keys(patch).length === 0) return;
    const res = this.db.update(topics).set(patch).where(eq(topics.id, id)).run();
    if (res.changes === 0) throw notFound();
  }

  deleteTopic(id: string) {
    this.db.transaction((tx) => {
      this.trashDocumentsOfTopics(tx, [id]);
      const res = tx.delete(topics).where(eq(topics.id, id)).run();
      if (res.changes === 0) throw notFound();
    });
  }

  /** Reorders topics; every id must belong to the same subject. */
  reorderTopics(ids: string[]) {
    this.db.transaction((tx) => {
      const rows = tx
        .select({ subjectId: topics.subjectId })
        .from(topics)
        .where(inArray(topics.id, ids))
        .all();
      if (rows.length !== ids.length || new Set(rows.map((r) => r.subjectId)).size !== 1) {
        throw new HttpError(400, 'invalid_reorder');
      }
      ids.forEach((id, position) =>
        tx.update(topics).set({ position }).where(eq(topics.id, id)).run(),
      );
    });
  }

  // ---- documents --------------------------------------------------------

  /** Registers an uploaded file (already on disk at `filePath`) in a topic. */
  createDocument(input: {
    id: string;
    topicId: string;
    title: string;
    filePath: string;
    fileSize: number;
    sourceUrl?: string;
  }) {
    this.requireTopic(input.topicId);
    this.db
      .insert(documents)
      .values({
        ...input,
        position: this.nextPosition(
          documents.position,
          documents,
          eq(documents.topicId, input.topicId),
        ),
      })
      .run();
    return this.summary(input.id);
  }

  getRow(id: string): DocumentRow {
    const row = this.db.select().from(documents).where(eq(documents.id, id)).get();
    if (!row) throw notFound();
    return row;
  }

  /** Live (non-trashed) document. */
  getLive(id: string): DocumentRow {
    const row = this.getRow(id);
    if (row.deletedAt) throw notFound();
    return row;
  }

  summary(id: string): DocumentSummary {
    const row = this.getLive(id);
    return toSummary(row, this.viewedCounts([id]).get(id) ?? 0);
  }

  detail(id: string): DocumentDetail {
    const row = this.getLive(id);
    const location = row.topicId
      ? this.db
          .select({ topicName: topics.name, subjectId: subjects.id, subjectName: subjects.name })
          .from(topics)
          .innerJoin(subjects, eq(subjects.id, topics.subjectId))
          .where(eq(topics.id, row.topicId))
          .get()
      : undefined;
    const pageSizes = this.db
      .select({ width: pages.width, height: pages.height })
      .from(pages)
      .where(eq(pages.documentId, id))
      .orderBy(asc(pages.pageNumber))
      .all();
    return {
      ...toSummary(row, this.viewedCounts([id]).get(id) ?? 0),
      lastScroll: row.lastScroll,
      subjectId: location?.subjectId ?? null,
      topicName: location?.topicName ?? null,
      subjectName: location?.subjectName ?? null,
      pageSizes,
      outline: row.outlineJson ? (JSON.parse(row.outlineJson) as OutlineEntry[]) : [],
    };
  }

  updateDocument(id: string, input: UpdateDocument) {
    this.getLive(id);
    const patch: Partial<typeof documents.$inferInsert> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.topicId !== undefined) {
      this.requireTopic(input.topicId);
      patch.topicId = input.topicId;
      patch.position = this.nextPosition(
        documents.position,
        documents,
        eq(documents.topicId, input.topicId),
      );
    }
    if (Object.keys(patch).length)
      this.db.update(documents).set(patch).where(eq(documents.id, id)).run();
  }

  reorderDocuments(ids: string[]) {
    this.db.transaction((tx) => {
      const rows = tx
        .select({ topicId: documents.topicId })
        .from(documents)
        .where(inArray(documents.id, ids))
        .all();
      if (rows.length !== ids.length || new Set(rows.map((r) => r.topicId)).size !== 1) {
        throw new HttpError(400, 'invalid_reorder');
      }
      ids.forEach((id, position) =>
        tx.update(documents).set({ position }).where(eq(documents.id, id)).run(),
      );
    });
  }

  /** Records where the reader is (F-LIB-04) and marks the page as viewed (reading progress). */
  saveReadingPosition(id: string, pos: ReadingPosition) {
    const row = this.getLive(id);
    const page = row.pageCount ? Math.min(pos.page, row.pageCount) : pos.page;
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.update(documents)
        .set({ lastPage: page, lastScroll: pos.scroll, lastOpenedAt: now })
        .where(eq(documents.id, id))
        .run();
      tx.update(pages)
        .set({ viewedAt: now })
        .where(
          and(
            eq(pages.documentId, id),
            inArray(pages.pageNumber, [page, ...(pos.viewed ?? [])]),
            isNull(pages.viewedAt),
          ),
        )
        .run();
      if (pos.seconds && pos.day) {
        tx.insert(studySessions)
          .values({ documentId: id, day: pos.day, seconds: pos.seconds, updatedAt: now })
          .onConflictDoUpdate({
            target: [studySessions.documentId, studySessions.day],
            set: { seconds: sql`${studySessions.seconds} + ${pos.seconds}`, updatedAt: now },
          })
          .run();
      }
    });
  }

  // ---- trash (owner decision + minimal F-LIB-05) ------------------------

  trashDocument(id: string) {
    const row = this.getLive(id);
    this.db
      .update(documents)
      .set({ deletedAt: new Date().toISOString(), trashedFromTopicId: row.topicId })
      .where(eq(documents.id, id))
      .run();
  }

  listTrash(): TrashedDocument[] {
    const rows = this.db
      .select()
      .from(documents)
      .where(isNotNull(documents.deletedAt))
      .orderBy(asc(documents.deletedAt))
      .all();
    const liveTopics = new Set(
      this.db
        .select({ id: topics.id })
        .from(topics)
        .all()
        .map((t) => t.id),
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      deletedAt: r.deletedAt!,
      purgeAt: new Date(new Date(r.deletedAt!).getTime() + TRASH_RETENTION_MS).toISOString(),
      originalTopicId:
        r.trashedFromTopicId && liveTopics.has(r.trashedFromTopicId) ? r.trashedFromTopicId : null,
    }));
  }

  restoreDocument(id: string, topicId: string) {
    const row = this.getRow(id);
    if (!row.deletedAt) throw new HttpError(409, 'not_in_trash');
    this.requireTopic(topicId);
    this.db
      .update(documents)
      .set({
        deletedAt: null,
        trashedFromTopicId: null,
        topicId,
        position: this.nextPosition(documents.position, documents, eq(documents.topicId, topicId)),
      })
      .where(eq(documents.id, id))
      .run();
  }

  /** Permanently deletes a trashed document and its files. */
  /** Deletes every document in the trash for good (F-LIB-05). */
  emptyTrash(): number {
    const rows = this.db.select().from(documents).where(isNotNull(documents.deletedAt)).all();
    for (const row of rows) {
      this.db.delete(documents).where(eq(documents.id, row.id)).run();
      this.removeFiles(row);
    }
    return rows.length;
  }

  purgeDocument(id: string) {
    const row = this.getRow(id);
    if (!row.deletedAt) throw new HttpError(409, 'not_in_trash');
    this.db.delete(documents).where(eq(documents.id, id)).run();
    this.removeFiles(row);
  }

  /** Purges documents that have been in the trash longer than the retention period. */
  purgeExpiredTrash(now = new Date()): number {
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_MS).toISOString();
    const expired = this.db.select().from(documents).where(lt(documents.deletedAt, cutoff)).all();
    for (const row of expired) {
      this.db.delete(documents).where(eq(documents.id, row.id)).run();
      this.removeFiles(row);
    }
    return expired.length;
  }

  coverPath(id: string) {
    return path.join(this.config.coverDir, `${id}.webp`);
  }

  // ---- helpers ----------------------------------------------------------

  private removeFiles(row: DocumentRow) {
    fs.rmSync(row.filePath, { force: true });
    // Pre-OCR original, when OCR replaced the served file.
    fs.rmSync(row.filePath.replace(/\.pdf$/, '.orig.pdf'), { force: true });
    fs.rmSync(this.coverPath(row.id), { force: true });
  }

  private trashDocumentsOfTopics(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    topicIds: string[],
  ) {
    const now = new Date().toISOString();
    for (const topicId of topicIds) {
      tx.update(documents)
        .set({ deletedAt: now, trashedFromTopicId: topicId })
        .where(and(eq(documents.topicId, topicId), isNull(documents.deletedAt)))
        .run();
    }
  }

  private viewedCounts(docIds: string[]): Map<string, number> {
    if (docIds.length === 0) return new Map();
    const rows = this.db
      .select({ documentId: pages.documentId, n: sql<number>`count(*)` })
      .from(pages)
      .where(and(inArray(pages.documentId, docIds), isNotNull(pages.viewedAt)))
      .groupBy(pages.documentId)
      .all();
    return new Map(rows.map((r) => [r.documentId, r.n]));
  }

  private nextPosition(
    column: typeof subjects.position | typeof topics.position | typeof documents.position,
    table: typeof subjects | typeof topics | typeof documents,
    where?: ReturnType<typeof eq>,
  ): number {
    const q = this.db.select({ max: sql<number | null>`max(${column})` }).from(table);
    const row = (where ? q.where(where) : q).get();
    return (row?.max ?? -1) + 1;
  }

  private requireSubject(id: string) {
    if (!this.db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, id)).get()) {
      throw new HttpError(400, 'unknown_subject');
    }
  }

  getTopicOrThrow(id: string) {
    this.requireTopic(id);
  }

  getSubjectOrThrow(id: string) {
    this.requireSubject(id);
  }

  private requireTopic(id: string) {
    if (!this.db.select({ id: topics.id }).from(topics).where(eq(topics.id, id)).get()) {
      throw new HttpError(400, 'unknown_topic');
    }
  }
}

function toSummary(d: DocumentRow, viewedPages: number): DocumentSummary {
  return {
    id: d.id,
    topicId: d.topicId,
    title: d.title,
    pageCount: d.pageCount,
    status: d.status,
    error: d.error,
    progressPct: d.pageCount ? Math.round((viewedPages / d.pageCount) * 100) : 0,
    lastPage: d.lastPage,
    lastOpenedAt: d.lastOpenedAt,
    createdAt: d.createdAt,
    hasCover: d.hasCover,
  };
}
