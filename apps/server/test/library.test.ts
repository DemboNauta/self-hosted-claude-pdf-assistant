import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LibraryTree, TrashedDocument } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { LibraryService } from '../src/services/library.js';
import { authedApp } from './helpers.js';

let app: FastifyInstance;
let headers: Record<string, string>;
let config: AppConfig;

beforeEach(async () => {
  ({ app, headers, config } = await authedApp());
});
afterEach(() => app.close());

const req = async (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) => {
  const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.body ? (res.json() as unknown) : null };
};
const tree = async () => (await req('GET', '/api/library')).body as LibraryTree;

/** Inserts a document row directly (upload is covered by the ingest tests). */
function addDoc(topicId: string, title = 'Doc'): string {
  const service = new LibraryService(dbOf(app), config);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pca-')), 'a.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  const id = `d${Math.random().toString(36).slice(2, 10)}`;
  service.createDocument({ id, topicId, title, filePath: file, fileSize: 8 });
  return id;
}
const dbOf = (a: FastifyInstance) => (a as unknown as { pcaDb: Db }).pcaDb;

describe('library', () => {
  it('creates, renames, reorders and nests subjects and topics', async () => {
    const a = (await req('POST', '/api/subjects', { name: 'Álgebra' })).body as { id: string };
    const b = (await req('POST', '/api/subjects', { name: 'Física' })).body as { id: string };
    expect((await req('PATCH', `/api/subjects/${a.id}`, { name: 'Álgebra lineal' })).status).toBe(
      204,
    );
    await req('POST', '/api/subjects/reorder', { ids: [b.id, a.id] });

    const t1 = (await req('POST', '/api/topics', { subjectId: a.id, name: 'Matrices' })).body as {
      id: string;
    };
    const t2 = (await req('POST', '/api/topics', { subjectId: a.id, name: 'Vectores' })).body as {
      id: string;
    };
    await req('POST', '/api/topics/reorder', { ids: [t2.id, t1.id] });

    const lib = await tree();
    expect(lib.subjects.map((s) => s.name)).toEqual(['Física', 'Álgebra lineal']);
    expect(lib.subjects[1]!.topics.map((t) => t.name)).toEqual(['Vectores', 'Matrices']);
  });

  it('validates input and rejects unknown parents', async () => {
    expect((await req('POST', '/api/subjects', { name: '' })).status).toBe(400);
    expect((await req('POST', '/api/topics', { subjectId: 'nope', name: 'x' })).status).toBe(400);
    expect((await req('PATCH', '/api/subjects/nope', { name: 'x' })).status).toBe(404);
  });

  it('refuses to reorder topics across subjects', async () => {
    const a = (await req('POST', '/api/subjects', { name: 'A' })).body as { id: string };
    const b = (await req('POST', '/api/subjects', { name: 'B' })).body as { id: string };
    const t1 = (await req('POST', '/api/topics', { subjectId: a.id, name: 'x' })).body as {
      id: string;
    };
    const t2 = (await req('POST', '/api/topics', { subjectId: b.id, name: 'y' })).body as {
      id: string;
    };
    expect((await req('POST', '/api/topics/reorder', { ids: [t1.id, t2.id] })).status).toBe(400);
  });

  it('moves documents between topics, tracks progress and trashes on topic deletion', async () => {
    const s = (await req('POST', '/api/subjects', { name: 'S' })).body as { id: string };
    const t1 = (await req('POST', '/api/topics', { subjectId: s.id, name: 'T1' })).body as {
      id: string;
    };
    const t2 = (await req('POST', '/api/topics', { subjectId: s.id, name: 'T2' })).body as {
      id: string;
    };
    const docId = addDoc(t1.id, 'Apuntes');

    expect((await req('PATCH', `/api/documents/${docId}`, { topicId: t2.id })).status).toBe(204);
    let lib = await tree();
    expect(lib.subjects[0]!.topics[1]!.documents.map((d) => d.id)).toEqual([docId]);

    expect(
      (await req('PUT', `/api/documents/${docId}/position`, { page: 3, scroll: 0.25 })).status,
    ).toBe(204);
    const detail = (await req('GET', `/api/documents/${docId}`)).body as {
      lastPage: number;
      lastScroll: number;
      lastOpenedAt: string;
    };
    expect(detail).toMatchObject({ lastPage: 3, lastScroll: 0.25 });
    await req('PUT', `/api/documents/${docId}/position`, {
      page: 3,
      scroll: 0.3,
      seconds: 40,
      day: '2026-09-26',
    });
    await req('PUT', `/api/documents/${docId}/position`, {
      page: 3,
      scroll: 0.3,
      seconds: 20,
      day: '2026-09-26',
    });
    const db = (
      app as unknown as {
        pcaDb: { $client: { prepare(q: string): { get(...a: unknown[]): unknown } } };
      }
    ).pcaDb;
    expect(
      db.$client.prepare('SELECT seconds FROM study_sessions WHERE document_id = ?').get(docId),
    ).toEqual({ seconds: 60 });
    expect(detail.lastOpenedAt).toBeTruthy();

    expect((await req('DELETE', `/api/topics/${t2.id}`)).status).toBe(204);
    lib = await tree();
    expect(lib.subjects[0]!.topics.map((t) => t.id)).toEqual([t1.id]);
    const trash = (await req('GET', '/api/trash')).body as TrashedDocument[];
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ id: docId, originalTopicId: null });
    expect((await req('GET', `/api/documents/${docId}`)).status).toBe(404);

    expect((await req('POST', `/api/trash/${docId}/restore`, { topicId: t1.id })).status).toBe(204);
    lib = await tree();
    expect(lib.subjects[0]!.topics[0]!.documents.map((d) => d.id)).toEqual([docId]);
  });

  it('purges trash after 30 days, including the file', async () => {
    const s = (await req('POST', '/api/subjects', { name: 'S' })).body as { id: string };
    const t = (await req('POST', '/api/topics', { subjectId: s.id, name: 'T' })).body as {
      id: string;
    };
    const docId = addDoc(t.id);
    const service = new LibraryService(dbOf(app), config);
    const file = service.getRow(docId).filePath;
    await req('DELETE', `/api/documents/${docId}`);

    expect(service.purgeExpiredTrash(new Date(Date.now() + 29 * 86400_000))).toBe(0);
    expect(service.purgeExpiredTrash(new Date(Date.now() + 31 * 86400_000))).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('backup and trash', () => {
  it('downloads a backup with the database and PDFs, never Claude credentials', async () => {
    const { list } = await import('tar');
    const { authedApp: build, seedDocument, tempDataDir } = await import('./helpers.js');
    const dirs = tempDataDir('pca-backup-');
    const { app: a, headers: h } = await build(dirs);
    try {
      const { docId } = await seedDocument(a, h, [['Hola.']]);
      fs.mkdirSync(path.join(dirs.dataDir, 'claude-home'), { recursive: true });
      fs.writeFileSync(path.join(dirs.dataDir, 'claude-home', '.credentials.json'), '{}');
      const res = await a.inject({ url: '/api/backup', headers: h });
      expect(res.headers['content-disposition']).toContain('pdfclaudeassistant-backup-');
      const file = path.join(dirs.dataDir, 'b.tgz');
      fs.writeFileSync(file, res.rawPayload);
      const names: string[] = [];
      await list({ file, onReadEntry: (e) => void names.push(e.path) });
      expect(names).toContain('pdfclaudeassistant.db');
      expect(names).toContain(`pdfs/${docId}.pdf`);
      expect(names.some((n) => n.includes('claude-home'))).toBe(false);
      // The snapshot is removed and the PDFs stay in place.
      expect(fs.readdirSync(dirs.dataDir).some((n) => n.startsWith('.backup-'))).toBe(false);
      expect(fs.existsSync(path.join(dirs.pdfDir, `${docId}.pdf`))).toBe(true);

      await a.inject({ method: 'DELETE', url: `/api/documents/${docId}`, headers: h });
      expect((await a.inject({ method: 'DELETE', url: '/api/trash', headers: h })).statusCode).toBe(
        204,
      );
      expect((await a.inject({ url: '/api/trash', headers: h })).json()).toEqual([]);
      expect(fs.existsSync(path.join(dirs.pdfDir, `${docId}.pdf`))).toBe(false);
    } finally {
      await a.close();
    }
  });
});
