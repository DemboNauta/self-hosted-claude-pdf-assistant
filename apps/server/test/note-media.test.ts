import { createCanvas } from '@napi-rs/canvas';
import type { Annotation, ThreadSummary, Whiteboard } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { annotationTools, type ToolContext } from '../src/claude/tools.js';
import type { WebImage, WebImageProvider } from '../src/services/webImages.js';
import { authedApp, seedDocument, servicesOf, tempDataDir } from './helpers.js';

let app: FastifyInstance;
let headers: Record<string, string>;
let docId: string;
let threadId: string;

async function png(w: number, h: number, color = '#3366cc') {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return canvas.encode('png');
}
const dataUrl = (buf: Buffer) => `data:image/png;base64,${buf.toString('base64')}`;

const downloads: string[] = [];
const fakeWeb: WebImageProvider = {
  search: async (query) =>
    [1, 2].map((n): WebImage => ({
      title: `${query} ${n}.jpg`,
      pageUrl: `https://commons.wikimedia.org/wiki/File:${n}.jpg`,
      imageUrl: `https://upload.wikimedia.org/full/${n}.png`,
      previewUrl: `https://upload.wikimedia.org/thumb/${n}.png`,
      width: 800,
      height: 600,
      credit: 'Jane Doe · CC BY-SA 4.0',
      description: 'A cell',
    })),
  download: async (url) => {
    downloads.push(url);
    return png(200, 150);
  },
};

beforeEach(async () => {
  downloads.length = 0;
  ({ app, headers } = await authedApp(tempDataDir('pca-media-'), { webImages: fakeWeb }));
  ({ docId } = await seedDocument(app, headers, [
    ['La mitocondria produce energía para la célula.'],
  ]));
  threadId = (
    await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
  ).json<ThreadSummary>().id;
});
afterEach(() => app.close());

async function newNote() {
  const res = await app.inject({
    method: 'POST',
    url: `/api/documents/${docId}/annotations`,
    headers,
    payload: {
      items: [
        { type: 'note', page: 1, color: 'yellow', anchor: { kind: 'point', x: 0.5, y: 0.5 } },
      ],
    },
  });
  return res.json<Annotation[]>()[0]!;
}

const list = async () =>
  (await app.inject({ url: `/api/documents/${docId}/annotations`, headers })).json<Annotation[]>();

const ctx = (): ToolContext => ({
  threadId,
  messageId: 'm1',
  docId,
  scope: { kind: 'document', id: docId },
  emit: () => {},
  record: () => {},
});

describe('pictures in notes', () => {
  it('keeps the pictures the student adds, and brings them back with an undo', async () => {
    const note = await newNote();
    const add = await app.inject({
      method: 'POST',
      url: `/api/annotations/${note.id}/images`,
      headers,
      payload: { dataUrl: dataUrl(await png(40, 30)), caption: 'Esquema' },
    });
    expect(add.statusCode).toBe(201);
    const [img] = add.json<Annotation>().images;
    expect(img).toMatchObject({ width: 40, height: 30, source: 'user', caption: 'Esquema' });

    const get = await app.inject({ url: `/api/note-images/${img!.id}`, headers });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');

    // Something that only claims to be a picture is refused.
    const fake = await app.inject({
      method: 'POST',
      url: `/api/annotations/${note.id}/images`,
      headers,
      payload: {
        dataUrl: `data:image/png;base64,${Buffer.from('not a picture').toString('base64')}`,
      },
    });
    expect(fake.statusCode).toBe(400);

    // Deleting the note hides its pictures; restoring it (undo) brings them back.
    await app.inject({
      method: 'POST',
      url: '/api/annotations/delete',
      headers,
      payload: { ids: [note.id] },
    });
    expect(await list()).toHaveLength(0);
    await app.inject({
      method: 'POST',
      url: `/api/documents/${docId}/annotations`,
      headers,
      payload: {
        items: [{ type: 'note', page: 1, color: 'yellow', anchor: note.anchor }],
        ids: [note.id],
      },
    });
    expect((await list())[0]!.images.map((i) => i.id)).toEqual([img!.id]);

    const del = await app.inject({ method: 'DELETE', url: `/api/note-images/${img!.id}`, headers });
    expect(del.json<Annotation>().images).toEqual([]);
  });

  it('scales big photos down', async () => {
    const note = await newNote();
    const add = await app.inject({
      method: 'POST',
      url: `/api/annotations/${note.id}/images`,
      headers,
      payload: { dataUrl: dataUrl(await png(3000, 1500)) },
    });
    expect(add.json<Annotation>().images[0]).toMatchObject({ width: 2400, height: 1200 });
  });

  it('lets Claude add a picture from the web to a margin note', async () => {
    const tools = annotationTools(servicesOf(app), ctx());
    const search = tools.find((t) => t.name === 'search_web_images')!;
    const notes = tools.find((t) => t.name === 'add_margin_notes')!;

    const bad = await notes.handler(
      {
        notes: [
          { page: 1, quote: 'La mitocondria produce energía', text: 'x', image: { id: 'i1' } },
        ],
      } as never,
      {},
    );
    expect(bad.isError).toBe(true);

    const found = await search.handler({ query: 'mitochondria', count: 2 } as never, {});
    expect(found.content.filter((c) => c.type === 'image')).toHaveLength(2);
    expect(JSON.stringify(found)).toContain('i2: mitochondria 2.jpg');

    await notes.handler(
      {
        notes: [
          {
            page: 1,
            quote: 'La mitocondria produce energía',
            text: 'Así es por dentro.',
            image: { id: 'i2', caption: 'Mitocondria' },
          },
        ],
      } as never,
      {},
    );
    const [note] = servicesOf(app).annotations.list(docId);
    expect(note!.status).toBe('active');
    expect(note!.images[0]).toMatchObject({
      source: 'claude',
      credit: 'Jane Doe · CC BY-SA 4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:2.jpg',
      caption: 'Mitocondria',
    });
    expect(downloads).toContain('https://upload.wikimedia.org/full/2.png');
  });
});

describe('whiteboards saved on the PDF', () => {
  async function drawOnBoard(color = '#ff0000') {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/threads/${threadId}/whiteboard`,
      headers,
      payload: {
        scene: { elements: [{ id: 'a', color }], files: {} },
        applied: [],
        snapshot: { png: dataUrl(await png(60, 40, color)), bounds: { x: 0, y: 0, w: 60, h: 40 } },
      },
    });
    expect(res.statusCode).toBe(200);
  }

  it('keeps a copy in a note, which can be opened again on the board and edited', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: `/api/documents/${docId}/boards`,
      headers,
      payload: { threadId, page: 1, anchor: { kind: 'point', x: 0.9, y: 0.1 } },
    });
    expect(empty.statusCode).toBe(409);

    await drawOnBoard('#ff0000');
    const res = await app.inject({
      method: 'POST',
      url: `/api/documents/${docId}/boards`,
      headers,
      payload: { threadId, page: 1, anchor: { kind: 'point', x: 0.9, y: 0.1 } },
    });
    expect(res.statusCode).toBe(201);
    const note = res.json<Annotation>();
    expect(note.board).toMatchObject({ pending: false });
    const boardId = note.board!.id;
    const snap = await app.inject({ url: `/api/boards/${boardId}/snapshot`, headers });
    expect(snap.headers['content-type']).toBe('image/png');

    // A copy: drawing on the conversation's board does not change it.
    await drawOnBoard('#00ff00');
    expect(servicesOf(app).media.board(boardId).sceneJson).toContain('#ff0000');

    // "Editar en la pizarra": the board shows the copy and saves go to the note too.
    const opened = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/whiteboard/replace`,
      headers,
      payload: { boardId },
    });
    const board = opened.json<Whiteboard>();
    expect(JSON.stringify(board.scene)).toContain('#ff0000');
    expect(board.linked).toEqual({ boardId, annotationId: note.id, documentId: docId, page: 1 });
    expect(servicesOf(app).whiteboards.status(threadId).linkedPage).toBe(1);
    await drawOnBoard('#0000ff');
    expect(servicesOf(app).media.board(boardId).sceneJson).toContain('#0000ff');

    // Unlinked, the note keeps the last version.
    await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/whiteboard/unlink`,
      headers,
    });
    await drawOnBoard('#123456');
    expect(servicesOf(app).media.board(boardId).sceneJson).toContain('#0000ff');

    // "Nueva pizarra" empties the conversation's board.
    const blank = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/whiteboard/replace`,
      headers,
      payload: { boardId: null },
    });
    expect(blank.json<Whiteboard>().scene).toEqual({ elements: [], files: {} });
  });

  it("keeps Claude's board in a note that follows the board until the next turn", async () => {
    const save = annotationTools(servicesOf(app), ctx()).find(
      (t) => t.name === 'save_whiteboard_to_pdf',
    )!;
    const empty = await save.handler({ page: 1, text: 'Resumen' } as never, {});
    expect(empty.isError).toBe(true);

    await drawOnBoard('#ff0000');
    await save.handler(
      { page: 1, quote: 'La mitocondria produce energía', text: 'Resumen' } as never,
      {},
    );
    const [note] = servicesOf(app).annotations.list(docId);
    expect(note).toMatchObject({ status: 'active', author: 'claude', board: { pending: true } });
    // During the answer, the note shows the conversation's board as it is.
    const preview = await app.inject({ url: `/api/boards/${note!.board!.id}/snapshot`, headers });
    expect(preview.statusCode).toBe(200);

    // Steps revealed later in the answer reach the note.
    await drawOnBoard('#00ff00');
    expect(servicesOf(app).media.board(note!.board!.id).sceneJson).toContain('#00ff00');
    // The next turn settles it: later drawings stay on the conversation's board only.
    servicesOf(app).media.settleThread(threadId);
    await drawOnBoard('#0000ff');
    const [settled] = servicesOf(app).annotations.list(docId);
    expect(settled!.board!.pending).toBe(false);
    expect(servicesOf(app).media.board(note!.board!.id).sceneJson).toContain('#00ff00');
  });
});
