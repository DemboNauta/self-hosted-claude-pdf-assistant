import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DocumentDetail, DocumentSummary, UploadSession } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import type { IngestService } from '../src/ingest/service.js';
import { titleFromFilename } from '../src/services/uploads.js';
import { makePdf } from './fixtures/pdf.js';
import { authedApp } from './helpers.js';

let app: FastifyInstance;
let headers: Record<string, string>;
let topicId: string;
let dataDir: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-ingest-'));
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
afterEach(async () => {
  // Let queued ingestion finish so the worker does not write to a closed database.
  await ingest().idle();
  await app.close();
});

const ingest = () => (app as unknown as { pcaIngest: IngestService }).pcaIngest;
const db = () => (app as unknown as { pcaDb: Db }).pcaDb;

/** Uploads one file through the chunked API, `chunk` bytes at a time. */
async function uploadOne(name: string, content: Buffer, chunk = 1000, topic = topicId) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers,
    payload: { topicId: topic, filename: name, size: content.length },
  });
  if (created.statusCode !== 201) return created;
  const { id } = created.json<UploadSession>();
  for (let offset = 0; offset < content.length; offset += chunk) {
    const res = await putChunk(id, offset, content.subarray(offset, offset + chunk));
    if (res.statusCode !== 200) return res;
  }
  return app.inject({ method: 'POST', url: `/api/uploads/${id}/complete`, headers });
}

function putChunk(id: string, offset: number, body: Buffer) {
  return app.inject({
    method: 'PUT',
    url: `/api/uploads/${id}?offset=${offset}`,
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload: body,
  });
}

describe('upload and ingestion', () => {
  it('uploads several PDFs, extracts text per page with coordinates and indexes them', async () => {
    const a = await makePdf([
      ['La fotosíntesis ocurre en los cloroplastos.'],
      ['El ciclo de Calvin fija CO2.'],
    ]);
    const b = await makePdf([['Mitocondria y respiración celular.']]);
    const created: DocumentSummary[] = [];
    for (const [name, content] of [
      ['fotosintesis.pdf', a],
      ['respiracion_celular.pdf', b],
    ] as const) {
      const res = await uploadOne(name, content);
      expect(res.statusCode).toBe(201);
      created.push(res.json<DocumentSummary>());
    }
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

    const search = await app.inject({
      url: `/api/search?q=${encodeURIComponent('CALVIN, fija!')}&scope=doc&id=${created[0]!.id}`,
      headers,
    });
    expect(search.json()).toEqual([
      {
        docId: created[0]!.id,
        title: 'fotosintesis',
        page: 2,
        snippet: 'El ciclo de Calvin fija CO2.',
      },
    ]);
    const global = await app.inject({ url: '/api/search?q=respiracion', headers });
    expect(global.json<{ docId: string }[]>().map((h) => h.docId)).toEqual([created[1]!.id]);
    expect(detail.outline).toEqual([]);

    const cover = await app.inject({ url: `/api/documents/${created[0]!.id}/cover`, headers });
    expect(cover.headers['content-type']).toBe('image/webp');
    const file = await app.inject({ url: `/api/documents/${created[0]!.id}/file`, headers });
    expect(file.rawPayload.equals(a)).toBe(true);
  });

  it('resumes after an interrupted chunk and rejects out-of-order offsets', async () => {
    const pdf = await makePdf([['Reanudar subidas.']]);
    const { id } = (
      await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers,
        payload: { topicId, filename: 'r.pdf', size: pdf.length },
      })
    ).json<UploadSession>();
    expect((await putChunk(id, 0, pdf.subarray(0, 500))).json()).toMatchObject({ received: 500 });

    const skipped = await putChunk(id, 900, pdf.subarray(900, 1000));
    expect(skipped.statusCode).toBe(409);
    expect(skipped.json()).toEqual({ error: 'offset_mismatch', received: 500 });

    // A chunk overflowing the declared size is refused and leaves nothing behind.
    const tooBig = await putChunk(id, 500, Buffer.concat([pdf.subarray(500), Buffer.alloc(10)]));
    expect(tooBig.statusCode).toBe(413);
    expect((await app.inject({ url: `/api/uploads/${id}`, headers })).json()).toMatchObject({
      received: 500,
    });

    const early = await app.inject({ method: 'POST', url: `/api/uploads/${id}/complete`, headers });
    expect(early.json()).toEqual({ error: 'upload_incomplete' });

    await putChunk(id, 500, pdf.subarray(500));
    const done = await app.inject({ method: 'POST', url: `/api/uploads/${id}/complete`, headers });
    expect(done.statusCode).toBe(201);
    const file = await app.inject({ url: `/api/documents/${id}/file`, headers });
    expect(file.rawPayload.equals(pdf)).toBe(true);
    expect((await app.inject({ url: `/api/uploads/${id}`, headers })).statusCode).toBe(404);
  });

  it('rejects files that are not PDFs, unknown topics and oversized files', async () => {
    const res = await uploadOne('virus.pdf', Buffer.from('MZ not a pdf'));
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'not_a_pdf' });

    const pdf = await makePdf([['x']]);
    expect((await uploadOne('a.pdf', pdf, 1000, 'nope')).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/uploads/..%2Fx', headers })).statusCode).toBe(404);
    expect(fs.readdirSync(path.join(dataDir, 'uploads'))).toEqual([]);
  });

  it('enforces MAX_UPLOAD_MB when set', async () => {
    await app.close();
    ({ app, headers } = await authedApp({
      dataDir,
      pdfDir: path.join(dataDir, 'pdfs'),
      maxUploadBytes: 100,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers,
      payload: { topicId, filename: 'big.pdf', size: 101 },
    });
    expect(res.statusCode).toBe(413);
  });

  it('marks corrupt PDFs as errored', async () => {
    const res = await uploadOne('roto.pdf', Buffer.from('%PDF-1.7\ngarbage'));
    const created = res.json<DocumentSummary>();
    await ingest().idle();
    const detail = (
      await app.inject({ url: `/api/documents/${created.id}`, headers })
    ).json<DocumentDetail>();
    expect(detail.status).toBe('error');
    expect(detail.error).toBeTruthy();
  });

  it('derives titles from file names', () => {
    expect(titleFromFilename('Tema_3 Derivadas.PDF')).toBe('Tema 3 Derivadas');
    expect(titleFromFilename('.pdf')).toBe('Documento sin título');
  });
});

describe('OCR of scanned pages', () => {
  it('runs OCR when pages have no text and re-indexes the result', async () => {
    const { authedApp: build, seedDocument: seed, tempDataDir: tmp } = await import('./helpers.js');
    const calls: string[] = [];
    const recognised = await makePdf([
      ['Texto reconocido por OCR.'],
      ['Segunda página escaneada.'],
    ]);
    const ocr = async (input: string, output: string) => {
      calls.push(input);
      fs.writeFileSync(output, recognised);
    };
    const dirs = tmp('pca-ocr-');
    const { app: a, headers: h } = await build(dirs, { ocr });
    try {
      const { docId } = await seed(a, h, [[], []]);
      const detail = (
        await a.inject({ url: `/api/documents/${docId}`, headers: h })
      ).json<DocumentDetail>();
      expect(detail).toMatchObject({ status: 'ready', pageCount: 2 });
      expect(calls).toHaveLength(1);
      const hits = (
        await a.inject({ url: `/api/search?q=reconocido&scope=doc&id=${docId}`, headers: h })
      ).json();
      expect(hits).toHaveLength(1);
      expect(fs.existsSync(path.join(dirs.pdfDir, `${docId}.orig.pdf`))).toBe(true);
    } finally {
      await a.close();
    }
  });
});
