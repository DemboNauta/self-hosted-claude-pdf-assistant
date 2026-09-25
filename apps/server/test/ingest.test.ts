import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DocumentDetail, DocumentSummary } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import type { IngestService } from '../src/ingest/service.js';
import { titleFromFilename } from '../src/routes/upload.js';
import { makePdf, multipartBody } from './fixtures/pdf.js';
import { authedApp } from './helpers.js';

let app: FastifyInstance;
let headers: Record<string, string>;
let topicId: string;

beforeEach(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-ingest-'));
  ({ app, headers } = await authedApp({
    dataDir,
    pdfDir: path.join(dataDir, 'pdfs'),
    coverDir: path.join(dataDir, 'covers'),
  }));
  const s = (
    await app.inject({ method: 'POST', url: '/api/subjects', headers, payload: { name: 'Bio' } })
  ).json<{ id: string }>();
  topicId = (
    await app.inject({
      method: 'POST',
      url: '/api/topics',
      headers,
      payload: { subjectId: s.id, name: 'Plantas' },
    })
  ).json<{ id: string }>().id;
});
afterEach(() => app.close());

const ingest = () => (app as unknown as { pcaIngest: IngestService }).pcaIngest;
const db = () => (app as unknown as { pcaDb: Db }).pcaDb;

async function upload(files: { name: string; content: Buffer }[]) {
  const { payload, contentType } = multipartBody(files);
  return app.inject({
    method: 'POST',
    url: `/api/documents/upload?topicId=${topicId}`,
    headers: { ...headers, 'content-type': contentType },
    payload,
  });
}

describe('upload and ingestion', () => {
  it('uploads several PDFs, extracts text per page with coordinates and indexes them', async () => {
    const a = await makePdf([
      ['La fotosíntesis ocurre en los cloroplastos.'],
      ['El ciclo de Calvin fija CO2.'],
    ]);
    const b = await makePdf([['Mitocondria y respiración celular.']]);
    const res = await upload([
      { name: 'fotosintesis.pdf', content: a },
      { name: 'respiracion_celular.pdf', content: b },
    ]);
    expect(res.statusCode).toBe(201);
    const { created } = res.json<{ created: DocumentSummary[] }>();
    expect(created.map((d) => d.title)).toEqual(['fotosintesis', 'respiracion celular']);
    expect(created[0]!.status).toBe('queued');

    await ingest().idle();

    const detail = (
      await app.inject({ url: `/api/documents/${created[0]!.id}`, headers })
    ).json<DocumentDetail>();
    expect(detail.error).toBeNull();
    expect(detail).toMatchObject({ status: 'ready', pageCount: 2, hasCover: true });
    expect(detail.pageSizes).toEqual([
      { width: 595, height: 842 },
      { width: 595, height: 842 },
    ]);

    const page = db()
      .$client.prepare(
        'SELECT text, text_layer_json FROM pages WHERE document_id = ? AND page_number = 2',
      )
      .get(created[0]!.id) as { text: string; text_layer_json: string };
    expect(page.text).toContain('ciclo de Calvin');
    const [item] = JSON.parse(page.text_layer_json) as [string, number, number, number, number][];
    expect(item![0]).toContain('Calvin');
    expect(item![1]).toBeCloseTo(50 / 595, 2);

    // FTS5 with diacritics folding: "fotosintesis" finds "fotosíntesis".
    const hits = db()
      .$client.prepare(
        "SELECT p.document_id, p.page_number FROM pages_fts f JOIN pages p ON p.id = f.rowid WHERE pages_fts MATCH 'fotosintesis'",
      )
      .all();
    expect(hits).toEqual([{ document_id: created[0]!.id, page_number: 1 }]);

    const cover = await app.inject({ url: `/api/documents/${created[0]!.id}/cover`, headers });
    expect(cover.headers['content-type']).toBe('image/webp');
    const file = await app.inject({ url: `/api/documents/${created[0]!.id}/file`, headers });
    expect(file.rawPayload.equals(a)).toBe(true);
  });

  it('rejects files that are not PDFs and unknown topics', async () => {
    const res = await upload([{ name: 'virus.pdf', content: Buffer.from('MZ not a pdf') }]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      created: [],
      rejected: [{ name: 'virus.pdf', reason: 'not_a_pdf' }],
    });

    const { payload, contentType } = multipartBody([
      { name: 'a.pdf', content: await makePdf([['x']]) },
    ]);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/documents/upload?topicId=nope',
      headers: { ...headers, 'content-type': contentType },
      payload,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('marks corrupt PDFs as errored', async () => {
    const res = await upload([{ name: 'roto.pdf', content: Buffer.from('%PDF-1.7\ngarbage') }]);
    const { created } = res.json<{ created: DocumentSummary[] }>();
    await ingest().idle();
    const detail = (
      await app.inject({ url: `/api/documents/${created[0]!.id}`, headers })
    ).json<DocumentDetail>();
    expect(detail.status).toBe('error');
    expect(detail.error).toBeTruthy();
  });

  it('derives titles from file names', () => {
    expect(titleFromFilename('Tema_3 Derivadas.PDF')).toBe('Tema 3 Derivadas');
    expect(titleFromFilename('.pdf')).toBe('Documento sin título');
  });
});
