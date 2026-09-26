import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DocumentDetail } from '@pdfclaudeassistant/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/services/url-import.js';
import { makePdf } from './fixtures/pdf.js';
import { authedApp, tempDataDir } from './helpers.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const pdf = await makePdf([['Documento importado desde una URL.']]);
  server = http.createServer((req, res) => {
    if (req.url === '/doc.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf);
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: '/doc.pdf' });
      res.end();
    } else if (req.url === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function setup(allowPrivateUrls: boolean) {
  const { app, headers } = await authedApp(tempDataDir('pca-url-'), { allowPrivateUrls });
  const s = (
    await app.inject({ method: 'POST', url: '/api/subjects', headers, payload: { name: 'S' } })
  ).json<{ id: string }>();
  const topicId = (
    await app.inject({
      method: 'POST',
      url: '/api/topics',
      headers,
      payload: { subjectId: s.id, name: 'T' },
    })
  ).json<{ id: string }>().id;
  const importUrl = (url: string) =>
    app.inject({
      method: 'POST',
      url: '/api/documents/import-url',
      headers,
      payload: { topicId, url },
    });
  return { app, headers, importUrl };
}

describe('import from URL', () => {
  it('blocks private, local and link-local addresses (SSRF)', async () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.10',
      '172.20.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
    const { app, importUrl } = await setup(false);
    try {
      expect((await importUrl(`${base}/doc.pdf`)).json()).toEqual({ error: 'url_not_allowed' });
      expect((await importUrl('http://localhost/doc.pdf')).json()).toEqual({
        error: 'url_not_allowed',
      });
      expect((await importUrl('file:///etc/passwd')).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('downloads a PDF (following redirects) and rejects other content', async () => {
    const { app, headers, importUrl } = await setup(true);
    try {
      const res = await importUrl(`${base}/redirect`);
      expect(res.statusCode).toBe(201);
      const doc = res.json<{ id: string; title: string }>();
      expect(doc.title).toBe('doc');
      await (app as unknown as { pcaIngest: { idle(): Promise<void> } }).pcaIngest.idle();
      const detail = (
        await app.inject({ url: `/api/documents/${doc.id}`, headers })
      ).json<DocumentDetail>();
      expect(detail).toMatchObject({ status: 'ready', pageCount: 1 });
      expect((await importUrl(`${base}/page.html`)).json()).toEqual({ error: 'not_a_pdf' });
      expect((await importUrl(`${base}/missing.pdf`)).json()).toEqual({
        error: 'url_fetch_failed',
      });
    } finally {
      await app.close();
    }
  });
});
