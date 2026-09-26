import type { Annotation, AppSettings, HighlightAnchor } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import type { PDFArray } from 'pdf-lib';
import { PDFDocument, PDFName } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { annotationTools, type ToolContext } from '../src/claude/tools.js';
import { quoteRects } from '../src/services/anchoring.js';
import { authedApp, seedDocument, tempDataDir, servicesOf } from './helpers.js';

let app: FastifyInstance;
let headers: Record<string, string>;
let docId: string;

beforeEach(async () => {
  ({ app, headers } = await authedApp(tempDataDir('pca-ann-')));
  ({ docId } = await seedDocument(app, headers, [
    ['La fotosíntesis ocurre en los cloroplastos.', 'El ciclo de Calvin fija el CO2.'],
    ['Segunda página.'],
  ]));
});
afterEach(() => app.close());

const list = async () =>
  (await app.inject({ url: `/api/documents/${docId}/annotations`, headers })).json<Annotation[]>();

describe('annotations', () => {
  it('creates, updates, deletes and restores annotations (undo)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/documents/${docId}/annotations`,
      headers,
      payload: {
        items: [
          { type: 'highlight', page: 1, color: 'yellow', anchor: { quote: 'ciclo de Calvin' } },
          {
            type: 'note',
            page: 2,
            color: 'yellow',
            content: 'Repasar',
            anchor: { kind: 'point', x: 0.5, y: 0.5 },
          },
          {
            type: 'drawing',
            page: 1,
            color: '#000000',
            anchor: {
              strokes: [
                {
                  points: [
                    [0.1, 0.1, 0.5],
                    [0.2, 0.2, 0.5],
                  ],
                  width: 0.004,
                  color: '#000000',
                },
              ],
            },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const [hl, note] = res.json<Annotation[]>();
    // Quote-only anchors get rectangles from the stored text layer.
    const rects = (hl!.anchor as HighlightAnchor).rects!;
    expect(rects).toHaveLength(1);
    expect(rects[0]!.x).toBeGreaterThan(50 / 595);
    expect(rects[0]!.y).toBeGreaterThan(0.05);

    await app.inject({
      method: 'PATCH',
      url: `/api/annotations/${hl!.id}`,
      headers,
      payload: { color: 'red' },
    });
    expect((await list()).find((a) => a.id === hl!.id)!.color).toBe('red');

    await app.inject({
      method: 'POST',
      url: '/api/annotations/delete',
      headers,
      payload: { ids: [note!.id] },
    });
    expect(await list()).toHaveLength(2);
    await app.inject({
      method: 'POST',
      url: `/api/documents/${docId}/annotations`,
      headers,
      payload: {
        items: [
          { type: 'note', page: 2, color: 'yellow', content: 'Repasar', anchor: note!.anchor },
        ],
        ids: [note!.id],
      },
    });
    expect((await list()).map((a) => a.id)).toContain(note!.id);
  });

  it('keeps note windows pinned, moved and resized, and moves sticky notes', async () => {
    const [note] = (
      await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/annotations`,
        headers,
        payload: {
          items: [
            { type: 'note', page: 1, color: 'yellow', anchor: { kind: 'point', x: 0.5, y: 0.5 } },
          ],
        },
      })
    ).json<Annotation[]>();
    expect(note!.display).toBeNull();

    const display = { pinned: true, x: 0.6, y: 0.1, w: 420, h: 300 };
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `/api/annotations/${note!.id}`, headers, payload });
    expect((await patch({ display })).statusCode).toBe(200);
    expect((await patch({ anchor: { kind: 'point', x: 0.2, y: 0.3 } })).statusCode).toBe(200);
    expect((await list())[0]).toMatchObject({ display, anchor: { x: 0.2, y: 0.3 } });

    // Undoing a delete restores the window too.
    await app.inject({
      method: 'POST',
      url: `/api/documents/${docId}/annotations`,
      headers,
      payload: {
        items: [{ type: 'note', page: 1, color: 'yellow', anchor: note!.anchor, display }],
        ids: [note!.id],
      },
    });
    expect((await list())[0]!.display).toEqual(display);

    expect((await patch({ display: { ...display, w: 5 } })).statusCode).toBe(400);
    expect((await patch({ display: null })).statusCode).toBe(200);
    expect((await list())[0]!.display).toBeNull();
  });

  it('rejects malformed anchors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/documents/${docId}/annotations`,
      headers,
      payload: { items: [{ type: 'drawing', page: 1, color: '#000', anchor: { strokes: [] } }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lets Claude propose key ideas that the student accepts or rejects', async () => {
    const events: unknown[] = [];
    const ctx: ToolContext = {
      threadId: 't',
      messageId: 'm',
      docId,
      scope: { kind: 'document', id: docId },
      emit: (e) => events.push(e),
      record: () => {},
    };
    const deps = servicesOf(app);
    const tool = annotationTools(deps, ctx).find((t) => t.name === 'highlight_key_ideas')!;
    const result = await tool.handler(
      {
        highlights: [
          { page: 1, quote: 'La fotosíntesis ocurre en los cloroplastos', reason: 'Idea central' },
          { page: 1, quote: 'texto que no existe' },
        ],
      } as never,
      {},
    );
    expect(JSON.stringify(result)).toContain('not found verbatim');
    expect(events).toContainEqual({ type: 'data_changed', threadId: 't', scope: 'annotations' });

    const proposals = await list();
    expect(proposals.map((a) => [a.author, a.status, a.color])).toEqual([
      ['claude', 'proposed', 'claude'],
      ['claude', 'proposed', 'claude'],
    ]);
    await app.inject({
      method: 'POST',
      url: '/api/annotations/status',
      headers,
      payload: { ids: [proposals[0]!.id], status: 'active' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/annotations/status',
      headers,
      payload: { ids: [proposals[1]!.id], status: 'rejected' },
    });
    expect((await list()).map((a) => a.status)).toEqual(['active']);

    const read = annotationTools(deps, ctx).find((t) => t.name === 'get_annotations')!;
    expect(JSON.stringify(await read.handler({} as never, {}))).toContain('Idea central');
  });

  it('exports a copy of the PDF with standard annotations', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/documents/${docId}/annotations`,
      headers,
      payload: {
        items: [
          { type: 'highlight', page: 1, color: 'green', anchor: { quote: 'Calvin' } },
          {
            type: 'note',
            page: 1,
            color: 'yellow',
            content: 'Ojo',
            anchor: { kind: 'point', x: 0.9, y: 0.1 },
          },
        ],
      },
    });
    const res = await app.inject({ url: `/api/documents/${docId}/export-annotated`, headers });
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('anotado');
    const pdf = await PDFDocument.load(res.rawPayload);
    const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots')) as PDFArray;
    const subtypes = annots
      .asArray()
      .map((ref) => String(pdf.context.lookup(ref, Object as never)));
    expect(annots.size()).toBe(2);
    expect(subtypes.join()).toContain('/Highlight');
    expect(subtypes.join()).toContain('/Text');
    // The stored original is untouched.
    const original = await app.inject({ url: `/api/documents/${docId}/file`, headers });
    expect(original.rawPayload.includes(Buffer.from('/Highlight'))).toBe(false);
  });

  it('keeps the palette meanings in settings', async () => {
    const s = (await app.inject({ url: '/api/settings', headers })).json<AppSettings>();
    expect(s.palette.map((p) => p.key)).toEqual(['yellow', 'green', 'blue', 'red', 'purple']);
    s.palette[3]!.meaning = 'Duda';
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { palette: s.palette, claudeModel: 'sonnet' },
    });
    expect(res.json<AppSettings>()).toMatchObject({
      claudeModel: 'sonnet',
      palette: expect.arrayContaining([expect.objectContaining({ key: 'red', meaning: 'Duda' })]),
    });
  });
});

describe('quote anchoring on stored text items', () => {
  it('interpolates inside items and ignores accents and spacing', () => {
    const items: [string, number, number, number, number][] = [
      ['El ciclo de ', 0.1, 0.2, 0.2, 0.02],
      ['Calvin', 0.3, 0.2, 0.1, 0.02],
    ];
    const rects = quoteRects(items, 'ciclo de calvín');
    expect(rects).toHaveLength(2);
    expect(rects[0]!.x).toBeCloseTo(0.1 + (0.2 * 3) / 12, 5);
    expect(rects[1]!.x).toBeCloseTo(0.3, 5);
    expect(rects[1]!.w).toBeCloseTo(0.1, 5);
    expect(quoteRects(items, 'Calvin', 2)).toEqual([]);
  });
});
