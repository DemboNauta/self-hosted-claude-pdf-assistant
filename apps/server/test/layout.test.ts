import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PointerGroup, ServerChatEvent, ToolEvent } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pointerTools, readingTools, type ToolContext } from '../src/claude/tools.js';
import { extractPdf, type TextLayerItem } from '../src/ingest/extract.js';
import {
  buildLayout,
  cluster,
  findLayoutBox,
  formatLayout,
  pageGraphics,
} from '../src/ingest/layout.js';
import { authedApp, seedDocument, servicesOf, tempDataDir } from './helpers.js';

/** A page with a heading, a paragraph and a small diagram (two boxes and an arrow) with labels. */
async function figurePdf(file: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText('Redes neuronales', { x: 50, y: 740, size: 24, font });
  ['Una red neuronal combina capas de neuronas.', 'Cada capa transforma la entrada.'].forEach(
    (line, i) => page.drawText(line, { x: 50, y: 700 - i * 16, size: 12, font }),
  );
  page.drawRectangle({
    x: 100,
    y: 400,
    width: 120,
    height: 60,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
  });
  page.drawRectangle({
    x: 350,
    y: 400,
    width: 120,
    height: 60,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
  });
  page.drawLine({ start: { x: 220, y: 430 }, end: { x: 350, y: 430 }, thickness: 1 });
  page.drawText('Entrada', { x: 130, y: 425, size: 12, font });
  page.drawText('Salida', { x: 385, y: 425, size: 12, font });
  // A lone rule under the text is decoration, not a figure.
  page.drawLine({ start: { x: 50, y: 660 }, end: { x: 550, y: 660 }, thickness: 0.5 });
  fs.writeFileSync(file, await doc.save());
}

describe('page layout', () => {
  it('finds headings, paragraphs and a vector figure with its labels', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-layout-'));
    const file = path.join(dir, 'f.pdf');
    await figurePdf(file);
    let items: TextLayerItem[] = [];
    await extractPdf(file, path.join(dir, 'cover.webp'), (pages) => (items = pages[0]!.items));

    const layout = buildLayout(1, items, await pageGraphics(file, 1));
    const kinds = layout.blocks.map((b) => [b.id, b.kind]);
    expect(kinds).toEqual([
      ['b1', 'heading'],
      ['b2', 'text'],
      ['f1', 'figure'],
    ]);
    const para = layout.blocks[1]!;
    expect(para.kind === 'text' && para.lines).toBe(2);
    const fig = layout.blocks[2]!;
    if (fig.kind !== 'figure') throw new Error('figure expected');
    expect(fig.source).toBe('drawing');
    expect(fig.labels.map((l) => [l.id, l.text])).toEqual([
      ['f1.1', 'Entrada'],
      ['f1.2', 'Salida'],
    ]);
    // The figure spans both boxes: x 100–470 of 600, y 340–400 of 800 (top-left origin).
    expect(fig.box.x).toBeCloseTo(100 / 600, 1);
    expect(fig.box.x + fig.box.w).toBeCloseTo(470 / 600, 1);
    expect(fig.box.y).toBeCloseTo(340 / 800, 1);
    expect(findLayoutBox(layout, 'f1.2')).toEqual(fig.labels[1]!.box);
    expect(findLayoutBox(layout, 'b9')).toBeNull();

    const out = formatLayout(layout);
    expect(out).toContain('b1 heading');
    expect(out).toContain('f1 figure (vector drawing)');
    expect(out).toContain('f1.1 label');
  });

  it('merges nearby boxes into one cluster', () => {
    const groups = cluster(
      [
        { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
        { x: 0.205, y: 0.1, w: 0.1, h: 0.1 },
        { x: 0.7, y: 0.7, w: 0.1, h: 0.1 },
      ],
      0.01,
    );
    expect(groups.map((g) => g.members.sort())).toEqual([[0, 1], [2]]);
  });

  it('reports a scanned page', () => {
    const layout = buildLayout(3, [], { images: [{ x: 0, y: 0, w: 1, h: 1 }], drawings: [] });
    expect(layout.scanned).toBe(true);
    expect(formatLayout(layout)).toContain('scanned');
  });
});

describe('layout tools', () => {
  let app: FastifyInstance;
  let docId: string;
  let events: ServerChatEvent[];
  let pointers: PointerGroup[];
  let ctx: ToolContext;

  beforeEach(async () => {
    const { app: a, headers } = await authedApp(tempDataDir('pca-layout-tools-'));
    app = a;
    ({ docId } = await seedDocument(app, headers, [['Primera línea de texto.', 'Segunda línea.']]));
    events = [];
    pointers = [];
    ctx = {
      threadId: 't',
      messageId: 'msg',
      docId,
      scope: { kind: 'document', id: docId },
      emit: (e) => events.push(e),
      record: (_e: ToolEvent) => {},
      recordPointer: (g) => pointers.push(g),
    };
  });
  afterEach(() => app.close());

  it('lists the page layout and points at a block by id, deferred until referenced', async () => {
    const deps = servicesOf(app);
    const layoutTool = readingTools(deps, ctx).find((t) => t.name === 'get_page_layout')!;
    const listed = JSON.stringify(await layoutTool.handler({ docId, page: 1 } as never, {}));
    expect(listed).toContain('b1 text');
    expect(listed).toContain('Primera línea de texto.');

    const [point] = pointerTools(deps, ctx);
    const res = JSON.stringify(
      await point!.handler(
        { page: 1, shapes: [{ type: 'rect', anchor: { kind: 'block', id: 'b1' } }] } as never,
        {},
      ),
    );
    expect(res).toContain('[[mark:m1]]');
    const group = (events.find((e) => e.type === 'pointer') as { group: PointerGroup }).group;
    expect(group).toMatchObject({ id: 'm1', messageId: 'msg', page: 1, deferred: true });
    expect(group.shapes[0]!.anchor.kind).toBe('rect');
    expect(pointers).toEqual([group]);

    // A second call gets the next id; "now" shows it at once.
    await point!.handler(
      {
        page: 1,
        now: true,
        shapes: [{ type: 'highlight', anchor: { kind: 'text', quote: 'Segunda línea' } }],
      } as never,
      {},
    );
    expect(pointers[1]).toMatchObject({ id: 'm2' });
    expect(pointers[1]!.deferred).toBeUndefined();

    const bad = await point!.handler(
      { page: 1, shapes: [{ type: 'rect', anchor: { kind: 'block', id: 'f7' } }] } as never,
      {},
    );
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad)).toContain('get_page_layout');
  });

  it('takes the student to a page, or opens one side by side', async () => {
    const tools = pointerTools(servicesOf(app), ctx);
    const go = tools.find((t) => t.name === 'go_to_page')!;
    const side = tools.find((t) => t.name === 'show_side_by_side')!;
    await go.handler({ page: 1, quote: 'Primera línea' } as never, {});
    await side.handler({ page: 1 } as never, {});
    expect(events.filter((e) => e.type === 'navigate')).toEqual([
      { type: 'navigate', threadId: 't', docId, page: 1, quote: 'Primera línea' },
      { type: 'navigate', threadId: 't', docId, page: 1, side: true },
    ]);
    expect((await go.handler({ page: 9 } as never, {})).isError).toBe(true);
  });
});
