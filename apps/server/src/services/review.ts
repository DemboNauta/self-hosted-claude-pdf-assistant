import type { Flashcard, ReviewQueue, ReviewRating } from '@pdfclaudeassistant/shared';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { State } from 'ts-fsrs';
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from 'ts-fsrs';
import type { Db } from '../db/client.js';
import { documents, flashcards, reviews, topics } from '../db/schema.js';
import { notFound } from './errors.js';
import { newId } from './ids.js';

type Row = typeof flashcards.$inferSelect;

const scheduler = fsrs({ enable_fuzz: true });
const STATE_NAMES = ['new', 'learning', 'review', 'relearning'] as const;

function parseCard(json: string): Card {
  const raw = JSON.parse(json) as Card & { due: string; last_review?: string };
  return {
    ...raw,
    due: new Date(raw.due),
    ...(raw.last_review ? { last_review: new Date(raw.last_review) } : {}),
  };
}

/** Human interval: "1 min", "10 min", "3 h", "4 d", "2 mes". */
export function formatInterval(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} d`;
  const m = Math.round(d / 30);
  if (m < 12) return `${m} mes`;
  return `${Math.round((d / 365) * 10) / 10} a`;
}

export interface CardFilter {
  subjectId?: string;
  topicId?: string;
  documentId?: string;
}

/** Flashcards and FSRS spaced repetition (F-REV-01/02/05). */
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  create(
    cards: {
      front: string;
      back: string;
      documentId?: string | null;
      page?: number | null;
      conceptId?: string | null;
    }[],
    author: 'user' | 'claude',
    status: 'active' | 'proposed' = 'active',
  ): Flashcard[] {
    const now = new Date();
    const card = createEmptyCard(now);
    const docIds = [...new Set(cards.map((c) => c.documentId).filter((d): d is string => !!d))];
    if (docIds.length) {
      const own = this.db
        .select({ id: documents.id })
        .from(documents)
        .where(and(inArray(documents.id, docIds), eq(documents.userId, this.userId)))
        .all();
      if (own.length !== docIds.length) throw notFound();
    }
    const ids = cards.map((c) => {
      const id = newId();
      this.db
        .insert(flashcards)
        .values({
          id,
          userId: this.userId,
          documentId: c.documentId ?? null,
          page: c.page ?? null,
          conceptId: c.conceptId ?? null,
          front: c.front,
          back: c.back,
          author,
          status,
          fsrsJson: JSON.stringify(card),
          dueAt: card.due.toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();
      return id;
    });
    return this.byIds(ids);
  }

  get(id: string): Flashcard {
    const [card] = this.byIds([id]);
    if (!card) throw notFound();
    return card;
  }

  update(id: string, patch: { front?: string; back?: string; status?: 'active' | 'rejected' }) {
    const res = this.db
      .update(flashcards)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(this.own(id))
      .run();
    if (res.changes === 0) throw notFound();
    return this.get(id);
  }

  delete(id: string) {
    const res = this.db.delete(flashcards).where(this.own(id)).run();
    if (res.changes === 0) throw notFound();
  }

  list(filter: CardFilter & { status?: Row['status'][] } = {}): Flashcard[] {
    return this.select(filter, { statuses: filter.status ?? ['active', 'proposed'] });
  }

  /** Due cards (oldest first), Claude's pending proposals and the next intervals. */
  queue(filter: CardFilter = {}, now = new Date()): ReviewQueue {
    const due = this.select(filter, { statuses: ['active'], dueBefore: now });
    const first = due[0];
    let preview: ReviewQueue['preview'] = null;
    if (first) {
      const row = this.db.select().from(flashcards).where(eq(flashcards.id, first.id)).get()!;
      const options = scheduler.repeat(parseCard(row.fsrsJson), now);
      preview = Object.fromEntries(
        ([1, 2, 3, 4] as const).map((r) => [
          r,
          formatInterval(options[r as Grade].card.due.getTime() - now.getTime()),
        ]),
      ) as Record<ReviewRating, string>;
    }
    return {
      due,
      preview,
      proposed: this.select(filter, { statuses: ['proposed'] }),
      total: this.select(filter, { statuses: ['active'] }).length,
    };
  }

  /** Applies a rating (Otra vez / Difícil / Bien / Fácil) and reschedules the card. */
  review(id: string, rating: ReviewRating, day: string, now = new Date()): Flashcard {
    const row = this.db.select().from(flashcards).where(this.own(id)).get();
    if (!row) throw notFound();
    const grade = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy][rating - 1] as Grade;
    const { card } = scheduler.next(parseCard(row.fsrsJson), now, grade);
    this.db.transaction((tx) => {
      tx.update(flashcards)
        .set({
          fsrsJson: JSON.stringify(card),
          dueAt: card.due.toISOString(),
          updatedAt: now.toISOString(),
        })
        .where(eq(flashcards.id, id))
        .run();
      tx.insert(reviews)
        .values({
          userId: this.userId,
          flashcardId: id,
          rating,
          reviewedAt: now.toISOString(),
          day,
        })
        .run();
    });
    return this.get(id);
  }

  dueCount(now = new Date()): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(flashcards)
        .where(
          and(
            eq(flashcards.userId, this.userId),
            eq(flashcards.status, 'active'),
            lte(flashcards.dueAt, now.toISOString()),
          ),
        )
        .get()?.n ?? 0
    );
  }

  private byIds(ids: string[]): Flashcard[] {
    if (!ids.length) return [];
    const rows = this.db
      .select({ f: flashcards, title: documents.title })
      .from(flashcards)
      .leftJoin(documents, eq(documents.id, flashcards.documentId))
      .where(and(eq(flashcards.userId, this.userId), inArray(flashcards.id, ids)))
      .all();
    const map = new Map(rows.map((r) => [r.f.id, this.toDto(r.f, r.title)]));
    return ids.map((i) => map.get(i)).filter((c): c is Flashcard => Boolean(c));
  }

  private select(
    filter: CardFilter,
    opts: { statuses: Row['status'][]; dueBefore?: Date },
  ): Flashcard[] {
    const conds = [eq(flashcards.userId, this.userId), inArray(flashcards.status, opts.statuses)];
    if (opts.dueBefore) conds.push(lte(flashcards.dueAt, opts.dueBefore.toISOString()));
    if (filter.documentId) conds.push(eq(flashcards.documentId, filter.documentId));
    if (filter.topicId) conds.push(eq(documents.topicId, filter.topicId));
    if (filter.subjectId) conds.push(eq(topics.subjectId, filter.subjectId));
    return this.db
      .select({ f: flashcards, title: documents.title })
      .from(flashcards)
      .leftJoin(documents, eq(documents.id, flashcards.documentId))
      .leftJoin(topics, eq(topics.id, documents.topicId))
      .where(and(...conds))
      .orderBy(asc(flashcards.dueAt), asc(flashcards.createdAt))
      .all()
      .map((r) => this.toDto(r.f, r.title));
  }

  private own(id: string) {
    return and(eq(flashcards.id, id), eq(flashcards.userId, this.userId));
  }

  private toDto(f: Row, title: string | null): Flashcard {
    const card = parseCard(f.fsrsJson);
    return {
      id: f.id,
      documentId: f.documentId,
      documentTitle: title,
      page: f.page,
      conceptId: f.conceptId,
      front: f.front,
      back: f.back,
      author: f.author,
      status: f.status,
      dueAt: f.dueAt,
      state: STATE_NAMES[card.state as State] ?? 'new',
      reps: card.reps,
      lapses: card.lapses,
      createdAt: f.createdAt,
    };
  }
}
