import type { Annotation, CreateAnnotation, UpdateAnnotation } from '@pdfclaudeassistant/shared';
import {
  drawingAnchorSchema,
  highlightAnchorSchema,
  noteAnchorSchema,
  shapeAnchorSchema,
} from '@pdfclaudeassistant/shared';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { annotations } from '../db/schema.js';
import { quoteRects, pageItems } from './anchoring.js';
import { HttpError, notFound } from './errors.js';
import { newId } from './ids.js';

type Row = typeof annotations.$inferSelect;

const ANCHOR_SCHEMAS = {
  highlight: highlightAnchorSchema,
  note: noteAnchorSchema,
  drawing: drawingAnchorSchema,
  shape: shapeAnchorSchema,
} as const;

function toDto(row: Row): Annotation {
  return {
    id: row.id,
    documentId: row.documentId,
    page: row.page,
    type: row.type,
    author: row.author,
    status: row.status,
    color: row.color,
    anchor: JSON.parse(row.anchorJson) as Annotation['anchor'],
    content: row.content,
    display: row.displayJson ? (JSON.parse(row.displayJson) as Annotation['display']) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const now = () => new Date().toISOString();

/** Permanent annotations (F-ANN-01..08) and Claude's proposals (F-ANN-04). */
export class AnnotationService {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  list(documentId: string, { includeRejected = false } = {}): Annotation[] {
    return this.db
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.userId, this.userId),
          eq(annotations.documentId, documentId),
          includeRejected ? undefined : ne(annotations.status, 'rejected'),
        ),
      )
      .orderBy(asc(annotations.page), asc(annotations.createdAt))
      .all()
      .map(toDto);
  }

  get(id: string): Annotation {
    const row = this.db.select().from(annotations).where(this.own(id)).get();
    if (!row) throw notFound();
    return toDto(row);
  }

  /** Creates annotations; `ids` restores previously deleted ones (undo). */
  create(
    documentId: string,
    items: CreateAnnotation[],
    opts: { ids?: string[]; author?: 'user' | 'claude'; status?: 'active' | 'proposed' } = {},
  ): Annotation[] {
    if (opts.ids && opts.ids.length !== items.length) throw new HttpError(400, 'invalid_request');
    const ts = now();
    const rows = items.map((item, i) => ({
      id: opts.ids?.[i] ?? newId(),
      userId: this.userId,
      documentId,
      page: item.page,
      type: item.type,
      author: item.type === 'shape' ? 'claude' : (opts.author ?? 'user'),
      status: opts.status ?? 'active',
      color: item.color,
      anchorJson: JSON.stringify(this.withRects(documentId, item.page, item.type, item.anchor)),
      content: item.content ?? null,
      displayJson: item.display ? JSON.stringify(item.display) : null,
      updatedAt: ts,
    }));
    this.db.transaction((tx) => {
      for (const r of rows) {
        tx.insert(annotations)
          .values(r)
          // Undo restores by id; another user's id is left alone (and then not found).
          .onConflictDoUpdate({
            target: annotations.id,
            set: { ...r },
            setWhere: eq(annotations.userId, this.userId),
          })
          .run();
      }
    });
    return rows.map((r) => this.get(r.id));
  }

  update(id: string, patch: UpdateAnnotation): Annotation {
    const current = this.get(id);
    const set: Partial<typeof annotations.$inferInsert> = { updatedAt: now() };
    if (patch.color !== undefined) set.color = patch.color;
    if (patch.content !== undefined) set.content = patch.content;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.display !== undefined)
      set.displayJson = patch.display ? JSON.stringify(patch.display) : null;
    if (patch.anchor !== undefined) {
      const parsed = ANCHOR_SCHEMAS[current.type].safeParse(patch.anchor);
      if (!parsed.success) throw new HttpError(400, 'invalid_request');
      set.anchorJson = JSON.stringify(parsed.data);
    }
    this.db.update(annotations).set(set).where(this.own(id)).run();
    return this.get(id);
  }

  setStatus(ids: string[], status: 'active' | 'rejected' | 'proposed') {
    this.db
      .update(annotations)
      .set({ status, updatedAt: now() })
      .where(and(eq(annotations.userId, this.userId), inArray(annotations.id, ids)))
      .run();
  }

  delete(ids: string[]) {
    this.db
      .delete(annotations)
      .where(and(eq(annotations.userId, this.userId), inArray(annotations.id, ids)))
      .run();
  }

  private own(id: string) {
    return and(eq(annotations.id, id), eq(annotations.userId, this.userId));
  }

  /** Quote-only anchors get rectangles from the stored text layer (for export and Claude). */
  private withRects(docId: string, page: number, type: string, anchor: unknown) {
    const a = anchor as { quote?: string; rects?: unknown[]; kind?: string };
    const quoted =
      type === 'highlight' || type === 'shape' || (type === 'note' && a.kind === 'text');
    if (quoted && a.quote && !a.rects?.length) {
      return { ...a, rects: quoteRects(pageItems(this.db, docId, page), a.quote) };
    }
    return anchor;
  }
}
