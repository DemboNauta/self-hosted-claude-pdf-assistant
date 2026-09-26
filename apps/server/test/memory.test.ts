import type { MemoryOverview } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { MemoryService } from '../src/services/memory.js';
import { authedApp, seedDocument, tempDataDir } from './helpers.js';

let app: FastifyInstance;
let headers: Record<string, string>;
let docId: string;
let memory: MemoryService;

beforeEach(async () => {
  ({ app, headers } = await authedApp(tempDataDir('pca-mem-')));
  ({ docId } = await seedDocument(app, headers, [['Derivadas e integrales.']]));
  memory = new MemoryService((app as unknown as { pcaDb: Db }).pcaDb);
});
afterEach(() => app.close());

describe('memory', () => {
  it('de-duplicates similar items and updates by id', () => {
    const a = memory.remember({
      scope: 'global',
      category: 'preference',
      content: 'Prefiere ejemplos prácticos antes de la teoría',
    });
    const b = memory.remember({
      scope: 'global',
      category: 'preference',
      content: 'Prefiere ejemplos prácticos antes que la teoría formal',
    });
    expect(b).toEqual({ id: a.id, action: 'updated' });
    const c = memory.remember({
      scope: 'global',
      category: 'study_habit',
      content: 'Estudia por las noches',
    });
    expect(c.action).toBe('created');
    memory.remember({
      scope: 'global',
      category: 'study_habit',
      content: 'Estudia por las mañanas',
      replaceId: c.id,
    });
    const o = memory.overview();
    expect(o.global.map((g) => g.content).sort()).toEqual([
      'Estudia por las mañanas',
      'Prefiere ejemplos prácticos antes que la teoría formal',
    ]);
  });

  it('tracks difficult concepts from exams and injects them as context', async () => {
    memory.remember({
      scope: 'document',
      documentId: docId,
      category: 'pending',
      content: 'Falta el tema 4',
    });
    memory.recordExam({
      documentId: docId,
      question: '¿Qué es una derivada?',
      userAnswer: 'No sé',
      correct: false,
      concepts: ['Derivada'],
      page: 1,
    });
    memory.markDifficult({ concept: 'derivada', documentId: docId, evidence: 'Pregunta repetida' });
    let [concept] = memory.concepts();
    expect(concept).toMatchObject({ name: 'Derivada', timesFailed: 2, page: 1 });
    expect(concept!.mastery).toBeCloseTo(0.1, 5);
    memory.recordExam({
      documentId: docId,
      question: 'Otra',
      userAnswer: 'Bien',
      correct: true,
      concepts: ['DERIVADA'],
    });
    [concept] = memory.concepts();
    expect(concept!.mastery).toBeCloseTo(0.2, 5);

    const ctx = memory.contextFor(docId)!;
    expect(ctx).toContain('Falta el tema 4');
    expect(ctx).toContain(`[${concept!.id}] Derivada: 0.20`);

    const overview = (await app.inject({ url: '/api/memory', headers })).json<MemoryOverview>();
    expect(overview.documents[0]).toMatchObject({ documentTitle: 'doc', category: 'pending' });
    expect(overview.concepts[0]).toMatchObject({ name: 'Derivada', documentTitle: 'doc' });
  });
});
