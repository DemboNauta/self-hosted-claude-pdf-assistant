import type {
  Concept,
  MemoryCategory,
  MemoryItem,
  MemoryOverview,
} from '@pdfclaudeassistant/shared';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { concepts, documents, examResults, memoryItems } from '../db/schema.js';
import { canonical } from './anchoring.js';
import { notFound } from './errors.js';
import { newId } from './ids.js';

const now = () => new Date().toISOString();

/** Lower-case, accent-free words: the unit for duplicate detection. */
function words(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );
}

function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export const conceptKey = (name: string) => [...name.trim()].map(canonical).join('');

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Distilled memory (F-MEM-01..06): short items written by Claude through tools,
 * de-duplicated on write, plus difficult concepts with a mastery level.
 */
export class MemoryService {
  constructor(private readonly db: Db) {}

  /** Adds a memory item, or updates a near-duplicate / the given one instead. */
  remember(input: {
    scope: 'global' | 'document';
    documentId?: string | null;
    category: MemoryCategory;
    content: string;
    replaceId?: string;
  }): { id: string; action: 'created' | 'updated' } {
    const documentId = input.scope === 'document' ? (input.documentId ?? null) : null;
    const existing = this.db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.scope, input.scope),
          documentId ? eq(memoryItems.documentId, documentId) : isNull(memoryItems.documentId),
        ),
      )
      .all();
    const target =
      (input.replaceId && existing.find((m) => m.id === input.replaceId)) ||
      existing.find(
        (m) => m.category === input.category && similarity(m.content, input.content) >= 0.6,
      );
    if (target) {
      this.db
        .update(memoryItems)
        .set({ content: input.content, category: input.category, updatedAt: now() })
        .where(eq(memoryItems.id, target.id))
        .run();
      return { id: target.id, action: 'updated' };
    }
    const id = newId();
    this.db
      .insert(memoryItems)
      .values({
        id,
        scope: input.scope,
        documentId,
        category: input.category,
        content: input.content,
        updatedAt: now(),
      })
      .run();
    return { id, action: 'created' };
  }

  /** Records a difficulty with a concept: merges by name, lowers mastery (F-MEM-03). */
  markDifficult(input: {
    concept: string;
    documentId?: string | null;
    page?: number | null;
    evidence: string;
  }) {
    const key = conceptKey(input.concept);
    const found = this.db.select().from(concepts).where(eq(concepts.key, key)).get();
    if (found) {
      this.db
        .update(concepts)
        .set({
          mastery: clamp(found.mastery - 0.15),
          timesFailed: found.timesFailed + 1,
          lastEvidence: input.evidence,
          lastSeenAt: now(),
          documentId: found.documentId ?? input.documentId ?? null,
          page: found.page ?? input.page ?? null,
        })
        .where(eq(concepts.id, found.id))
        .run();
      return found.id;
    }
    const id = newId();
    this.db
      .insert(concepts)
      .values({
        id,
        name: input.concept.trim(),
        key,
        documentId: input.documentId ?? null,
        page: input.page ?? null,
        mastery: 0.25,
        timesFailed: 1,
        lastEvidence: input.evidence,
        lastSeenAt: now(),
      })
      .run();
    return id;
  }

  updateMastery(id: string, delta: number, evidence: string) {
    const c = this.db.select().from(concepts).where(eq(concepts.id, id)).get();
    if (!c) throw notFound();
    this.db
      .update(concepts)
      .set({ mastery: clamp(c.mastery + delta), lastEvidence: evidence, lastSeenAt: now() })
      .where(eq(concepts.id, id))
      .run();
    return clamp(c.mastery + delta);
  }

  /** Stores an exam answer and updates the concepts involved. */
  recordExam(input: {
    documentId: string | null;
    question: string;
    userAnswer: string;
    correct: boolean;
    concepts: string[];
    page?: number | null;
  }) {
    this.db
      .insert(examResults)
      .values({
        id: newId(),
        documentId: input.documentId,
        question: input.question,
        userAnswer: input.userAnswer,
        correct: input.correct,
        conceptsJson: JSON.stringify(input.concepts),
      })
      .run();
    for (const name of input.concepts) {
      if (!input.correct) {
        this.markDifficult({
          concept: name,
          documentId: input.documentId,
          page: input.page,
          evidence: `Fallo en examen: ${input.question}`,
        });
      } else {
        const found = this.db
          .select()
          .from(concepts)
          .where(eq(concepts.key, conceptKey(name)))
          .get();
        if (found) this.updateMastery(found.id, 0.1, `Acierto en examen: ${input.question}`);
      }
    }
  }

  overview(): MemoryOverview {
    const items = this.db
      .select({ m: memoryItems, title: documents.title })
      .from(memoryItems)
      .leftJoin(documents, eq(documents.id, memoryItems.documentId))
      .orderBy(desc(memoryItems.updatedAt))
      .all()
      .map(({ m, title }) => this.item(m, title));
    return {
      global: items.filter((i) => i.scope === 'global'),
      documents: items.filter((i) => i.scope === 'document'),
      concepts: this.concepts(),
    };
  }

  concepts(opts: { documentId?: string; limit?: number } = {}): Concept[] {
    return this.db
      .select({ c: concepts, title: documents.title })
      .from(concepts)
      .leftJoin(documents, eq(documents.id, concepts.documentId))
      .where(opts.documentId ? eq(concepts.documentId, opts.documentId) : undefined)
      .orderBy(asc(concepts.mastery), desc(concepts.lastSeenAt))
      .limit(opts.limit ?? 500)
      .all()
      .map(({ c, title }) => ({
        id: c.id,
        name: c.name,
        documentId: c.documentId,
        documentTitle: title ?? null,
        page: c.page,
        mastery: c.mastery,
        timesFailed: c.timesFailed,
        lastEvidence: c.lastEvidence,
        lastSeenAt: c.lastSeenAt,
      }));
  }

  /**
   * Memory injected with each turn (F-MEM-04): global items, the document's items
   * and the weakest concepts (this document's first). Ids let Claude update items.
   */
  contextFor(documentId: string, maxChars = 3500): string | undefined {
    const rows = this.db
      .select()
      .from(memoryItems)
      .where(or(eq(memoryItems.scope, 'global'), eq(memoryItems.documentId, documentId)))
      .orderBy(desc(memoryItems.updatedAt))
      .limit(80)
      .all();
    const weak = this.db
      .select()
      .from(concepts)
      .where(sql`${concepts.mastery} < 0.7`)
      .orderBy(
        sql`CASE WHEN ${concepts.documentId} = ${documentId} THEN 0 ELSE 1 END`,
        asc(concepts.mastery),
      )
      .limit(12)
      .all();
    const lines: string[] = [];
    const global = rows.filter((r) => r.scope === 'global');
    const doc = rows.filter((r) => r.scope === 'document');
    if (global.length) {
      lines.push('Global:', ...global.map((r) => `- [${r.id}] (${r.category}) ${r.content}`));
    }
    if (doc.length) {
      lines.push('This document:', ...doc.map((r) => `- [${r.id}] (${r.category}) ${r.content}`));
    }
    if (weak.length) {
      lines.push(
        'Difficult concepts (mastery 0–1):',
        ...weak.map(
          (c) =>
            `- [${c.id}] ${c.name}: ${c.mastery.toFixed(2)}, failed ${c.timesFailed}×${c.page ? `, p. ${c.page}` : ''}${c.documentId && c.documentId !== documentId ? ' (other document)' : ''}`,
        ),
      );
    }
    if (!lines.length) return undefined;
    let out = lines.join('\n');
    if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…`;
    return out;
  }

  private item(m: typeof memoryItems.$inferSelect, title: string | null): MemoryItem {
    return {
      id: m.id,
      scope: m.scope,
      documentId: m.documentId,
      documentTitle: title,
      category: m.category as MemoryCategory,
      content: m.content,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }
}
