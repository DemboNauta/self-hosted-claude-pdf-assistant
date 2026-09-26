import type { DailyBrief, Flashcard, ReviewQueue, StudyStats } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatInterval } from '../src/services/review.js';
import { authedApp, seedDocument, tempDataDir } from './helpers.js';

let app: FastifyInstance;
let headers: Record<string, string>;
let docId: string;
let topicId: string;
let briefCalls: number;

const today = new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  briefCalls = 0;
  const fakeQuery = (() => {
    briefCalls++;
    return (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 's',
        apiKeySource: 'none',
        model: 'fake',
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '**Derivada:** repasa la regla de la cadena.',
      };
    })();
  }) as never;
  ({ app, headers } = await authedApp(tempDataDir('pca-rev-'), { claudeQuery: fakeQuery }));
  ({ docId, topicId } = await seedDocument(app, headers, [['Derivadas.']]));
});
afterEach(() => app.close());

const req = async <T>(method: string, url: string, payload?: unknown) =>
  (
    await app.inject({ method: method as 'GET', url, headers, ...(payload ? { payload } : {}) })
  ).json<T>();

describe('flashcards and FSRS review', () => {
  it('schedules cards with FSRS and counts reviews for stats', async () => {
    const [card] = await req<Flashcard[]>('POST', '/api/flashcards', {
      cards: [
        {
          front: '¿Qué es una derivada?',
          back: 'La tasa de cambio instantánea.',
          documentId: docId,
          page: 1,
        },
      ],
    });
    expect(card).toMatchObject({ state: 'new', documentTitle: 'doc', author: 'user' });

    let queue = await req<ReviewQueue>('GET', `/api/review/queue?topicId=${topicId}`);
    expect(queue.due.map((c) => c.id)).toEqual([card!.id]);
    expect(Object.keys(queue.preview!)).toEqual(['1', '2', '3', '4']);
    expect((await req<ReviewQueue>('GET', '/api/review/queue?topicId=other')).due).toEqual([]);

    const after = await req<Flashcard>('POST', `/api/flashcards/${card!.id}/review`, {
      rating: 4,
      day: today,
    });
    expect(new Date(after.dueAt).getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
    queue = await req<ReviewQueue>('GET', '/api/review/queue');
    expect(queue.due).toEqual([]);

    const stats = await req<StudyStats>('GET', `/api/stats?day=${today}`);
    expect(stats).toMatchObject({
      streakDays: 1,
      reviewsTotal: 1,
      retention: 1,
      cards: { total: 1, due: 0 },
    });
    expect(stats.days.at(-1)).toMatchObject({ day: today, reviews: 1 });
    expect(stats.subjects[0]!.topics[0]!.documents[0]).toMatchObject({ id: docId });
  });

  it('formats intervals for the rating buttons', () => {
    expect(formatInterval(60_000)).toBe('1 min');
    expect(formatInterval(3 * 3600_000)).toBe('3 h');
    expect(formatInterval(4 * 86400_000)).toBe('4 d');
    expect(formatInterval(90 * 86400_000)).toBe('3 mes');
  });

  it("generates today's brief once and caches it", async () => {
    let brief = await req<DailyBrief>('GET', `/api/review/today?day=${today}`);
    expect(brief).toMatchObject({ text: null, dueCount: 0 });
    brief = await req<DailyBrief>('POST', `/api/review/today?day=${today}`);
    expect(brief.text).toContain('regla de la cadena');
    brief = await req<DailyBrief>('GET', `/api/review/today?day=${today}`);
    expect(brief.text).toContain('regla de la cadena');
    expect(briefCalls).toBe(1);
  });
});
