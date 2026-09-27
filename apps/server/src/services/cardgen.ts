import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Flashcard } from '@pdfclaudeassistant/shared';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ClaudeCredentials } from '../claude/credentials.js';
import { baseAgentOptions } from '../claude/options.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { documents, flashcards, pages, topics } from '../db/schema.js';
import { HttpError } from './errors.js';
import type { ReviewService } from './review.js';
import type { SettingsService } from './settings.js';

type QueryFn = typeof query;

/** Text of read pages sent to Claude in one request (roughly 8k tokens). */
const MAX_SOURCE_CHARS = 32_000;
const MAX_PAGE_CHARS = 4_000;
/** Existing cards shown to Claude so it does not repeat them. */
const MAX_EXISTING = 80;

const CARDS_PROMPT = `You write flashcards for spaced repetition in a study app, from pages the student has already read.
Rules:
- One idea per card. The front is a precise question (or a term to define); the back is a short, self-contained answer (one to three sentences, or a formula).
- Test understanding of what matters (definitions, relations, causes, procedures, formulas), not trivia such as page numbers or the author's wording.
- Use only what the pages say. Write in the language of the pages. Mathematics in KaTeX ($...$).
- Do not repeat or rephrase the cards the student already has.
- Spread the cards over the pages given, favouring the ones marked as not yet covered.
Answer ONLY with a JSON array, no prose: [{"ref": "D1", "page": 12, "front": "...", "back": "..."}], where "ref" and "page" say which page each card comes from.`;

const cardsSchema = z
  .array(
    z.object({
      ref: z.string().max(10),
      page: z.number().int().min(1),
      front: z.string().min(3).max(1000),
      back: z.string().min(1).max(2000),
    }),
  )
  .max(60);

export interface CardSource {
  subjectIds?: string[];
  topicIds?: string[];
  documentIds?: string[];
}

/** First JSON array in Claude's answer (it may wrap it in a code fence). */
export function parseCards(text: string) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = cardsSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Flashcards written by Claude from what the student has read (pages viewed in the
 * reader) of the chosen subjects, topics or documents; by default the documents read
 * most recently. They are created ready to review.
 */
export class CardGenService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly review: ReviewService,
    private readonly settings: SettingsService,
    private readonly runQuery: QueryFn,
    private readonly credentials: ClaudeCredentials,
    private readonly userId: string,
  ) {}

  /** Live, ready documents of the user matching `source` (all of them when empty). */
  private documents(source: CardSource) {
    const { subjectIds = [], topicIds = [], documentIds = [] } = source;
    const scoped = subjectIds.length + topicIds.length + documentIds.length > 0;
    const scope = or(
      documentIds.length ? inArray(documents.id, documentIds) : undefined,
      topicIds.length ? inArray(documents.topicId, topicIds) : undefined,
      subjectIds.length ? inArray(topics.subjectId, subjectIds) : undefined,
    );
    return this.db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .leftJoin(topics, eq(topics.id, documents.topicId))
      .where(
        and(
          eq(documents.userId, this.userId),
          isNull(documents.deletedAt),
          eq(documents.status, 'ready'),
          scoped ? scope : isNotNull(documents.lastOpenedAt),
        ),
      )
      .orderBy(desc(documents.lastOpenedAt))
      .limit(scoped ? 200 : 5)
      .all();
  }

  /** Whether anything read can be turned into cards (the daily run skips otherwise). */
  hasReadPages(source: CardSource = {}): boolean {
    const docs = this.documents(source).map((d) => d.id);
    if (!docs.length) return false;
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(pages)
      .where(and(inArray(pages.documentId, docs), isNotNull(pages.viewedAt)))
      .get();
    return (row?.n ?? 0) > 0;
  }

  async generate(source: CardSource, count: number): Promise<Flashcard[]> {
    const auth = this.credentials.forUser(this.userId);
    if (!auth) throw new HttpError(409, 'claude_not_configured');
    const docs = this.documents(source);
    if (!docs.length) throw new HttpError(409, 'nothing_read');
    const docIds = docs.map((d) => d.id);

    // Pages already covered by cards go last, so each request moves on to new material.
    const covered = new Set(
      this.db
        .select({ doc: flashcards.documentId, page: flashcards.page })
        .from(flashcards)
        .where(
          and(
            eq(flashcards.userId, this.userId),
            inArray(flashcards.documentId, docIds),
            inArray(flashcards.status, ['active', 'proposed']),
          ),
        )
        .all()
        .map((c) => `${c.doc}:${c.page}`),
    );
    const read = this.db
      .select({ doc: pages.documentId, page: pages.pageNumber, text: pages.text })
      .from(pages)
      .where(and(inArray(pages.documentId, docIds), isNotNull(pages.viewedAt)))
      .orderBy(desc(pages.viewedAt))
      .all()
      .filter((p) => p.text.trim());
    if (!read.length) throw new HttpError(409, 'nothing_read');
    read.sort(
      (a, b) =>
        Number(covered.has(`${a.doc}:${a.page}`)) - Number(covered.has(`${b.doc}:${b.page}`)),
    );

    const refOf = new Map(docs.map((d, i) => [d.id, `D${i + 1}`]));
    const chosen: typeof read = [];
    let size = 0;
    for (const p of read) {
      const len = Math.min(p.text.length, MAX_PAGE_CHARS);
      if (size + len > MAX_SOURCE_CHARS && chosen.length) break;
      chosen.push(p);
      size += len;
    }
    // Back in reading order, grouped by document.
    chosen.sort((a, b) => docIds.indexOf(a.doc) - docIds.indexOf(b.doc) || a.page - b.page);

    const existing = this.db
      .select({ front: flashcards.front })
      .from(flashcards)
      .where(
        and(
          eq(flashcards.userId, this.userId),
          inArray(flashcards.documentId, docIds),
          inArray(flashcards.status, ['active', 'proposed']),
        ),
      )
      .orderBy(desc(flashcards.createdAt))
      .limit(MAX_EXISTING)
      .all();

    const used = new Set(chosen.map((p) => p.doc));
    const prompt = [
      `Write ${count} flashcards.`,
      'Documents:',
      ...docs.filter((d) => used.has(d.id)).map((d) => `- ${refOf.get(d.id)}: "${d.title}"`),
      existing.length
        ? `Cards the student already has (do not repeat):\n${existing.map((c) => `- ${c.front}`).join('\n')}`
        : '',
      'Pages:',
      ...chosen.map(
        (p) =>
          `--- ${refOf.get(p.doc)} p. ${p.page}${covered.has(`${p.doc}:${p.page}`) ? ' (already has cards)' : ' (not yet covered)'} ---\n${p.text.slice(0, MAX_PAGE_CHARS)}`,
      ),
    ]
      .filter(Boolean)
      .join('\n');

    let text = '';
    const q = this.runQuery({
      prompt,
      options: {
        ...baseAgentOptions(this.config, auth),
        ...(this.settings.claudeModel() ? { model: this.settings.claudeModel()! } : {}),
        systemPrompt: CARDS_PROMPT,
        maxTurns: 1,
        persistSession: false,
      },
    });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result') {
        if (msg.subtype !== 'success' || msg.is_error) throw new HttpError(502, 'claude_failed');
        text = msg.result;
      }
    }

    const docOf = new Map([...refOf].map(([id, ref]) => [ref, id]));
    const sent = new Set(chosen.map((p) => `${p.doc}:${p.page}`));
    const cards = parseCards(text)
      .filter((c) => docOf.has(c.ref))
      .slice(0, count)
      .map((c) => {
        const documentId = docOf.get(c.ref)!;
        // A page Claude was not shown is a slip: keep the card, drop the page.
        const page = sent.has(`${documentId}:${c.page}`) ? c.page : null;
        return { front: c.front, back: c.back, documentId, page };
      });
    if (!cards.length) throw new HttpError(502, 'claude_failed');
    return this.review.create(cards, 'claude', 'active');
  }
}
