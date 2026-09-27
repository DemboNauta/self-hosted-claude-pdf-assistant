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
let cardCalls: number;
/** What the fake Claude answers when asked for flashcards. */
let cardsAnswer: string;

const today = new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  briefCalls = 0;
  cardCalls = 0;
  cardsAnswer = '[]';
  const fakeQuery = ((args: { prompt: string; options: { systemPrompt?: string } }) => {
    const cards = args.options.systemPrompt?.includes('flashcards') ?? false;
    if (cards) cardCalls++;
    else briefCalls++;
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
        result: cards ? cardsAnswer : '**Derivada:** repasa la regla de la cadena.',
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

describe('flashcards written by Claude', () => {
  const read = (id: string, page = 1) =>
    app.inject({
      method: 'PUT',
      url: `/api/documents/${id}/position`,
      headers,
      payload: { page, scroll: 0 },
    });

  it('needs something read first', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/flashcards/generate',
      headers,
      payload: { documentIds: [docId], count: 3 },
    });
    expect(res.statusCode).toBe(409);
    expect(cardCalls).toBe(0);
  });

  it('writes cards from the read pages of the chosen documents, ready to review', async () => {
    const other = await seedDocument(app, headers, [['Integrales por partes y sustitución.']]);
    await read(docId);
    await read(other.docId);
    cardsAnswer =
      'Aquí tienes:\n```json\n[{"ref":"D1","page":1,"front":"¿Qué son las derivadas?","back":"Tasas de cambio."},' +
      '{"ref":"D1","page":9,"front":"Otra","back":"Página que no se envió"},' +
      '{"ref":"D7","page":1,"front":"Documento desconocido","back":"x"}]\n```';
    const res = await app.inject({
      method: 'POST',
      url: '/api/flashcards/generate',
      headers,
      payload: { topicIds: [topicId], count: 5 },
    });
    expect(res.statusCode).toBe(201);
    const cards = res.json<Flashcard[]>();
    expect(cards.map((c) => [c.front, c.page, c.author, c.documentId])).toEqual([
      ['¿Qué son las derivadas?', 1, 'claude', docId],
      ['Otra', null, 'claude', docId],
    ]);
    // Ready to review straight away (not proposals).
    const queue = await req<ReviewQueue>('GET', '/api/review/queue');
    expect(queue.due).toHaveLength(2);
  });

  it("adds a few cards with today's brief, only once a day", async () => {
    await read(docId);
    cardsAnswer = '[{"ref":"D1","page":1,"front":"¿Derivada?","back":"Tasa de cambio."}]';
    let brief = await req<DailyBrief>('POST', `/api/review/today?day=${today}`);
    expect(brief).toMatchObject({ claudeCards: 1, dueCount: 1 });
    brief = await req<DailyBrief>('POST', `/api/review/today?day=${today}`);
    expect(brief.claudeCards).toBe(1);
    expect(cardCalls).toBe(1);
    expect(briefCalls).toBe(2);
    expect((await req<ReviewQueue>('GET', '/api/review/queue')).due).toHaveLength(1);
  });
});
