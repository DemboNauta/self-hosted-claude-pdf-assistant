import { DIAGRAM_KINDS, type Diagram } from '@pdfclaudeassistant/shared';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { diagrams, documents } from '../db/schema.js';
import { HttpError, notFound } from './errors.js';
import { newId } from './ids.js';

/** Longest Mermaid source accepted (a readable diagram is far smaller). */
export const MAX_DIAGRAM_SOURCE = 20_000;

/**
 * Light check of Claude's Mermaid source before it is stored: a known diagram type on
 * the first line, and none of the directives that could run code or pull in styles.
 * The browser renders it with Mermaid's strict security level on top of this.
 */
export function checkDiagramSource(source: string): string | null {
  const text = source.trim();
  if (!text) return 'The diagram is empty.';
  if (text.length > MAX_DIAGRAM_SOURCE) return 'The diagram is too large; simplify it.';
  const first = text.split('\n', 1)[0]!.trim().split(/\s+/)[0]!;
  if (!(DIAGRAM_KINDS as readonly string[]).includes(first)) {
    return `Start with one of: ${DIAGRAM_KINDS.join(', ')} (e.g. "mindmap" or "flowchart TD").`;
  }
  if (/^\s*(click|style|classDef|linkStyle)\b|%%\{|<script|javascript:/im.test(text)) {
    return 'Do not use click, style, classDef, linkStyle, init directives or HTML.';
  }
  return null;
}

export interface NewDiagram {
  documentId: string | null;
  title: string;
  source: string;
  fromPage: number | null;
  toPage: number | null;
}

const now = () => new Date().toISOString();

/** Claude's visual schemas: stored as they are made, listed per PDF and overall. */
export class DiagramService {
  constructor(private readonly db: Db) {}

  private query() {
    return this.db
      .select({
        id: diagrams.id,
        documentId: diagrams.documentId,
        documentTitle: documents.title,
        title: diagrams.title,
        source: diagrams.source,
        fromPage: diagrams.fromPage,
        toPage: diagrams.toPage,
        createdAt: diagrams.createdAt,
        updatedAt: diagrams.updatedAt,
      })
      .from(diagrams)
      .leftJoin(documents, eq(documents.id, diagrams.documentId));
  }

  /** Newest first; diagrams of PDFs in the trash are hidden until they are restored. */
  list(documentId?: string): Diagram[] {
    const live = or(isNull(diagrams.documentId), isNull(documents.deletedAt));
    return this.query()
      .where(documentId ? and(eq(diagrams.documentId, documentId), live) : live)
      .orderBy(desc(diagrams.updatedAt))
      .all();
  }

  get(id: string): Diagram {
    const row = this.query().where(eq(diagrams.id, id)).get();
    if (!row) throw notFound();
    return row;
  }

  create(input: NewDiagram): Diagram {
    const problem = checkDiagramSource(input.source);
    if (problem) throw new HttpError(400, 'invalid_diagram');
    const id = newId();
    this.db
      .insert(diagrams)
      .values({ id, ...input, source: input.source.trim(), updatedAt: now() })
      .run();
    return this.get(id);
  }

  update(id: string, patch: { title?: string; source?: string }): Diagram {
    this.get(id);
    if (patch.source !== undefined && checkDiagramSource(patch.source)) {
      throw new HttpError(400, 'invalid_diagram');
    }
    this.db
      .update(diagrams)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.source !== undefined ? { source: patch.source.trim() } : {}),
        updatedAt: now(),
      })
      .where(eq(diagrams.id, id))
      .run();
    return this.get(id);
  }

  delete(id: string) {
    this.get(id);
    this.db.delete(diagrams).where(eq(diagrams.id, id)).run();
  }
}
