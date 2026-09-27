import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Flashcard } from '@pdfclaudeassistant/shared';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ClaudeCredentials } from '../claude/credentials.js';
import { baseAgentOptions } from '../claude/options.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { documents, flashcards, pages, topics } from '../db/schema.js';
import { DISTRACTORS } from '@pdfclaudeassistant/shared';
import { HttpError } from './errors.js';
import type { ReviewService } from './review.js';
import type { SettingsService } from './settings.js';

type QueryFn = typeof query;

/** Text of read pages sent to Claude in one request (roughly 8k tokens). */
const MAX_SOURCE_CHARS = 32_000;
const MAX_PAGE_CHARS = 4_000;
/** Existing cards shown to Claude so it does not repeat them. */
const MAX_EXISTING = 80;

const WRONG_RULES = `The wrong answers must be plausible to someone who studied carelessly (common confusions, related but different concepts, typical mistakes), clearly wrong to someone who knows, in the same language, style and length as the right answer, so the right one does not stand out. Never "all of the above" or "none of the above".`;

const CARDS_PROMPT = `You write flashcards for spaced repetition in a study app, from pages the student has already read.
Rules:
- One idea per card. The front is a precise question (or a term to define); the back is a short, self-contained answer (one to three sentences, or a formula).
- Test understanding of what matters (definitions, relations, causes, procedures, formulas, how to apply them), not trivia such as page numbers or the author's wording.
- Ask about the subject, never about the document: no questions on how the text is organised, what a module/chapter/section covers, what is explained first or next, or in what order the author presents things (e.g. not "¿Qué caso se estudia primero en el módulo?"). Each card must make sense to someone who never saw these notes.
- Use only what the pages say. Write in the language of the pages. Mathematics in KaTeX ($...$).
- Do not repeat or rephrase the cards the student already has.
- Spread the cards over the pages given, favouring the ones marked as not yet covered.
- The cards are answered as multiple choice: add three wrong answers ("wrong"). ${WRONG_RULES}
Answer ONLY with a JSON array, no prose: [{"ref": "D1", "page": 12, "front": "...", "back": "...", "wrong": ["...", "...", "..."]}], where "ref" and "page" say which page each card comes from.`;

const DISTRACTORS_PROMPT = `You write the wrong options of multiple-choice flashcards in a study app. For each card you get its question and its right answer.
${WRONG_RULES}
Answer ONLY with a JSON array, no prose: [{"ref": "C1", "wrong": ["...", "...", "..."]}], one entry per card.`;

const HINT_PROMPT = `You give hints to a student answering a multiple-choice flashcard in a study app. You get the question, the right answer, the wrong options and, when available, the page the card comes from.
Write ONE short hint (one or two sentences) in the language of the question that helps the student recall or reason towards the right answer: a related idea, an analogy, what to think about, or why a tempting option fails.
Never state the right answer or its key words, never say which option (or number) is right, and do not simply rule out all wrong options. Plain text, no preamble.`;

const cardsSchema = z
  .array(
    z.object({
      ref: z.string().max(10),
      page: z.number().int().min(1),
      front: z.string().min(3).max(1000),
      back: z.string().min(1).max(2000),
      wrong: z.array(z.string().min(1).max(1000)).optional(),
    }),
  )
  .max(60);

const wrongSchema = z
  .array(z.object({ ref: z.string().max(10), wrong: z.array(z.string().min(1).max(1000)) }))
  .max(60);

/** Three distinct wrong answers that differ from the right one, or null. */
function cleanWrong(wrong: string[] | undefined, back: string): string[] | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const out = [...new Set((wrong ?? []).map((w) => w.trim()).filter(Boolean))].filter(
    (w) => norm(w) !== norm(back),
  );
  return out.length >= DISTRACTORS ? out.slice(0, DISTRACTORS) : null;
}

export interface CardSource {
  subjectIds?: string[];
  topicIds?: string[];
  documentIds?: string[];
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** First JSON array in Claude's answer (it may wrap it in a code fence). */
function parseArray<T>(text: string, schema: z.ZodType<T[]>): T[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = schema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export const parseCards = (text: string) => parseArray(text, cardsSchema);

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

  /** One single-turn request to Claude with the user's own subscription. */
  private async ask(systemPrompt: string, prompt: string): Promise<string> {
    const auth = this.credentials.forUser(this.userId);
    if (!auth) throw new HttpError(409, 'claude_not_configured');
    let text = '';
    const q = this.runQuery({
      prompt,
      options: {
        ...baseAgentOptions(this.config, auth),
        ...(this.settings.claudeModel() ? { model: this.settings.claudeModel()! } : {}),
        systemPrompt,
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
    return text;
  }

  /** A hint for a card, from Claude, that does not give the answer away. */
  async hint(id: string): Promise<{ hint: string }> {
    const card = this.review.get(id);
    const page =
      card.documentId && card.page
        ? this.db
            .select({ text: pages.text })
            .from(pages)
            .where(and(eq(pages.documentId, card.documentId), eq(pages.pageNumber, card.page)))
            .get()
        : undefined;
    const prompt = [
      `Question: ${card.front}`,
      `Right answer: ${card.back}`,
      card.distractors ? `Wrong options: ${card.distractors.join(' | ')}` : '',
      page?.text ? `Page the card comes from:\n${page.text.slice(0, MAX_PAGE_CHARS)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const hint = (await this.ask(HINT_PROMPT, prompt)).trim();
    if (!hint) throw new HttpError(502, 'claude_failed');
    return { hint };
  }

  /**
   * Writes the wrong options of cards that have none yet (the student's own cards and
   * those from before multiple choice), in one request, and returns the updated cards.
   */
  async fillDistractors(ids: string[]): Promise<Flashcard[]> {
    const cards = this.review.byIds(ids).filter((c) => !c.distractors);
    if (!cards.length) return [];
    const prompt = cards
      .map((c, i) => `--- C${i + 1} ---\nQuestion: ${c.front}\nRight answer: ${c.back}`)
      .join('\n\n');
    const answer = parseArray(await this.ask(DISTRACTORS_PROMPT, prompt), wrongSchema);
    const done: string[] = [];
    for (const a of answer) {
      const card = cards[Number(a.ref.replace(/^C/, '')) - 1];
      const wrong = card && cleanWrong(a.wrong, card.back);
      if (!card || !wrong) continue;
      this.review.setDistractors(card.id, wrong);
      done.push(card.id);
    }
    return this.review.byIds(done);
  }

  async generate(source: CardSource, count: number): Promise<Flashcard[]> {
    if (!this.credentials.forUser(this.userId)) throw new HttpError(409, 'claude_not_configured');
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

    const text = await this.ask(CARDS_PROMPT, prompt);
    const docOf = new Map([...refOf].map(([id, ref]) => [ref, id]));
    const sent = new Set(chosen.map((p) => `${p.doc}:${p.page}`));
    const cards = parseCards(text)
      .filter((c) => docOf.has(c.ref))
      .slice(0, count)
      .map((c) => {
        const documentId = docOf.get(c.ref)!;
        // A page Claude was not shown is a slip: keep the card, drop the page.
        const page = sent.has(`${documentId}:${c.page}`) ? c.page : null;
        return {
          front: c.front,
          back: c.back,
          documentId,
          page,
          distractors: cleanWrong(c.wrong, c.back),
        };
      });
    if (!cards.length) throw new HttpError(502, 'claude_failed');
    // Created in random order, so the review interleaves them instead of following the
    // order of the notes.
    return this.review.create(shuffle(cards), 'claude', 'active');
  }
}
