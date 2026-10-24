import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import type {
  ChatFile,
  ChatImage,
  ChatMessage,
  DocumentQuestion,
  ServerChatEvent,
  ThreadSummary,
  UploadSession,
} from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentTools, readingTools, type ToolContext } from '../src/claude/tools.js';
import type { IngestService } from '../src/ingest/service.js';
import { makeDocx } from './fixtures/docx.js';
import { makePdf } from './fixtures/pdf.js';
import { authedApp, servicesOf } from './helpers.js';

interface FakeCall {
  prompt: string;
  options: { resume?: string; allowedTools?: string[]; systemPrompt?: unknown };
}

let app: FastifyInstance;
let headers: Record<string, string>;
let docId: string;
let calls: FakeCall[];
let script: (call: FakeCall) => AsyncGenerator<unknown>;

const streamText = (...parts: string[]) =>
  parts.flatMap((p, i) => [
    ...(i === 0
      ? [
          {
            type: 'stream_event',
            parent_tool_use_id: null,
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
        ]
      : []),
    {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } },
    },
  ]);

beforeEach(async () => {
  calls = [];
  script = async function* () {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      apiKeySource: 'none',
      model: 'fake',
    };
    for (const m of streamText('La fotosíntesis ', 'ocurre en los cloroplastos [[cite:x:1]].'))
      yield m;
    yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-chat-'));
  const fakeQuery = ((args: FakeCall) => {
    calls.push(args);
    return script(args);
  }) as never;
  ({ app, headers } = await authedApp(
    { dataDir, pdfDir: path.join(dataDir, 'pdfs'), coverDir: path.join(dataDir, 'covers') },
    { claudeQuery: fakeQuery },
  ));

  const s = (
    await app.inject({ method: 'POST', url: '/api/subjects', headers, payload: { name: 'Bio' } })
  ).json<{ id: string }>();
  const topicId = (
    await app.inject({
      method: 'POST',
      url: '/api/topics',
      headers,
      payload: { subjectId: s.id, name: 'T' },
    })
  ).json<{ id: string }>().id;
  const pdf = await makePdf(
    Array.from({ length: 12 }, (_, i) => [
      `Pagina ${i + 1}: la fotosintesis y el ciclo de Calvin.`,
    ]),
  );
  const up = (
    await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers,
      payload: { topicId, filename: 'bio.pdf', size: pdf.length },
    })
  ).json<UploadSession>();
  await app.inject({
    method: 'PUT',
    url: `/api/uploads/${up.id}?offset=0`,
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload: pdf,
  });
  docId = (
    await app.inject({ method: 'POST', url: `/api/uploads/${up.id}/complete`, headers })
  ).json<{ id: string }>().id;
  await (app as unknown as { pcaIngest: IngestService }).pcaIngest.idle();
});
afterEach(() => app.close());

/** Sends one question over the WebSocket and collects events until the turn ends. */
async function ask(threadId: string, text: string, extra: Record<string, unknown> = {}) {
  const ws = await app.injectWS('/ws/chat', { headers });
  const events: ServerChatEvent[] = [];
  const done = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const ev = JSON.parse(String(raw)) as ServerChatEvent;
      events.push(ev);
      // Errors before any answer (e.g. a rejected request) end the exchange too.
      if (ev.type === 'assistant_done' || (ev.type === 'error' && !ev.messageId)) resolve();
    });
  });
  ws.send(
    JSON.stringify({
      type: 'user_message',
      threadId,
      clientId: 'c1',
      text,
      mode: 'free',
      context: { docId, currentPage: 3 },
      ...extra,
    }),
  );
  await done;
  ws.terminate();
  return events;
}

describe('chat', () => {
  it('streams an answer, stores the thread and resumes the Claude session', async () => {
    const thread = (
      await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
    ).json<ThreadSummary>();

    const events = await ask(thread.id, '¿Dónde ocurre la fotosíntesis?', {
      context: { docId, currentPage: 3, selection: { page: 3, text: 'el ciclo de Calvin' } },
      mode: 'eli5',
    });
    expect(events.map((e) => e.type)).toEqual([
      'user_message',
      'assistant_start',
      'assistant_delta',
      'assistant_delta',
      'assistant_done',
    ]);
    const done = events.at(-1) as Extract<ServerChatEvent, { type: 'assistant_done' }>;
    expect(done.message).toMatchObject({
      role: 'assistant',
      status: 'complete',
      content: 'La fotosíntesis ocurre en los cloroplastos [[cite:x:1]].',
    });

    // Per-turn context travels in the user message, not the system prompt.
    expect(calls[0]!.prompt).toContain('looking at page 3');
    expect(calls[0]!.prompt).toContain('el ciclo de Calvin');
    expect(calls[0]!.prompt).toContain('Explain it simply');
    expect(calls[0]!.options.resume).toBeUndefined();
    expect(calls[0]!.options.allowedTools).toContain('mcp__pca__get_pages');
    expect(JSON.stringify(calls[0]!.options.systemPrompt)).not.toContain('page 3');

    await ask(thread.id, 'Otra pregunta');
    expect(calls[1]!.options.resume).toBe('session-1');

    const history = (
      await app.inject({ url: `/api/threads/${thread.id}/messages`, headers })
    ).json<{ messages: ChatMessage[] }>().messages;
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history[0]).toMatchObject({
      mode: 'eli5',
      context: { selection: { text: 'el ciclo de Calvin' } },
    });
    const list = (await app.inject({ url: `/api/documents/${docId}/threads`, headers })).json<
      ThreadSummary[]
    >();
    expect(list[0]).toMatchObject({ title: '¿Dónde ocurre la fotosíntesis?', messageCount: 4 });
  });

  it('stores the marks Claude drew with the answer, to show them again later', async () => {
    script = async function* (call) {
      yield { type: 'system', subtype: 'init', session_id: 's', apiKeySource: 'none' };
      const tools = (
        call.options as {
          mcpServers: {
            pca: {
              instance: {
                _registeredTools: Record<
                  string,
                  { handler: (args: unknown, extra: unknown) => Promise<unknown> }
                >;
              };
            };
          };
        }
      ).mcpServers.pca.instance._registeredTools;
      await tools.point_at!.handler(
        { page: 1, shapes: [{ type: 'circle', anchor: { kind: 'text', quote: 'fotosíntesis' } }] },
        {},
      );
      for (const m of streamText('[[mark:m1]] Aquí está.')) yield m;
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
    };
    const thread = (
      await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
    ).json<ThreadSummary>();
    const events = await ask(thread.id, 'Señálalo');
    expect(events.find((e) => e.type === 'pointer')).toMatchObject({
      group: { id: 'm1', page: 1, deferred: true },
    });
    const history = (
      await app.inject({ url: `/api/threads/${thread.id}/messages`, headers })
    ).json<{ messages: ChatMessage[] }>().messages;
    expect(history[1]!.pointers).toEqual([
      expect.objectContaining({ id: 'm1', docId, page: 1, messageId: history[1]!.id }),
    ]);
  });

  it('tells Claude when the student drew on the whiteboard', async () => {
    const thread = (
      await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
    ).json<ThreadSummary>();
    await app.inject({
      method: 'PUT',
      url: `/api/threads/${thread.id}/whiteboard`,
      headers,
      payload: {
        scene: { elements: [], files: {} },
        applied: [],
        snapshot: { png: 'data:image/png;base64,AAAA', bounds: { x: 0, y: 0, w: 10, h: 10 } },
        studentEdited: true,
      },
    });
    await ask(thread.id, '¿Está bien mi ejercicio?');
    expect(calls[0]!.prompt).toContain('drawn or written on the whiteboard');
    expect(calls[0]!.options.allowedTools).toContain('mcp__pca__whiteboard_view');
  });

  it('lists the questions asked about passages, with their answers', async () => {
    const thread = (
      await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
    ).json<ThreadSummary>();
    const rects = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }];
    await ask(thread.id, '¿Qué es?', {
      context: { docId, currentPage: 3, selection: { page: 3, text: 'el ciclo de Calvin', rects } },
    });
    await ask(thread.id, 'Sin selección');
    // An older question without rects is located from the stored text layer.
    await ask(thread.id, '', {
      mode: 'eli5',
      context: { docId, currentPage: 5, selection: { page: 5, text: 'ciclo de Calvin' } },
    });

    const res = await app.inject({ url: `/api/documents/${docId}/questions`, headers });
    expect(res.statusCode).toBe(200);
    const questions = res.json<DocumentQuestion[]>();
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({
      threadId: thread.id,
      kind: 'selection',
      page: 3,
      quote: 'el ciclo de Calvin',
      rects,
      mode: 'free',
      question: '¿Qué es?',
      answer: 'La fotosíntesis ocurre en los cloroplastos [[cite:x:1]].',
      answerStatus: 'complete',
    });
    expect(questions[1]).toMatchObject({ page: 5, mode: 'eli5', question: '' });
    expect(questions[1]!.rects.length).toBeGreaterThan(0);

    expect((await app.inject({ url: '/api/documents/nope/questions', headers })).statusCode).toBe(
      404,
    );
  });

  it('chats about a whole topic with its documents in context (F-CHAT-08)', async () => {
    const detail = (await app.inject({ url: `/api/documents/${docId}`, headers })).json<{
      topicId: string;
    }>();
    const thread = (
      await app.inject({ url: `/api/topics/${detail.topicId}/threads/active`, headers })
    ).json<ThreadSummary>();
    expect(thread).toMatchObject({ topicId: detail.topicId, documentId: null });
    // A document context does not match a topic thread.
    const wrong = await ask(thread.id, 'Hola');
    expect(wrong.find((e) => e.type === 'error')).toBeTruthy();

    const events = await ask(thread.id, '¿Qué temas hay?', {
      context: { topicId: detail.topicId },
    });
    expect(events.at(-1)).toMatchObject({ type: 'assistant_done' });
    const prompt = calls.at(-1)!.prompt;
    expect(prompt).toContain('whole topic "T"');
    expect(prompt).toContain(`"bio" (id ${docId}, 12 pages)`);
    expect(prompt).not.toContain('looking at page');
  });

  it("asks about one of Claude's marks with an image of its area", async () => {
    const thread = (
      await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
    ).json<ThreadSummary>();
    const pointed = {
      page: 1,
      rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 },
      labels: 'Aquí',
      text: 'la fotosintesis',
    };
    await ask(thread.id, '', { context: { docId, currentPage: 1, pointed } });
    const prompt = calls[0]!.prompt as unknown as AsyncIterable<{
      message: { content: { type: string; text?: string }[] };
    }>;
    const messages = [];
    for await (const m of prompt) messages.push(m);
    const [image, text] = messages[0]!.message.content;
    expect(image!.type).toBe('image');
    expect(text!.text).toContain('clicked one of the marks you drew on page 1');
    expect(text!.text).toContain('your labels: Aquí');
    expect(text!.text).toContain('explain in more detail what you marked');
  });

  it('asks about a freehand mark with an image of the marked area', async () => {
    const thread = (
      await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
    ).json<ThreadSummary>();
    const [drawing] = (
      await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/annotations`,
        headers,
        payload: {
          items: [
            {
              type: 'drawing',
              page: 2,
              color: '#d1242f',
              anchor: {
                strokes: [
                  {
                    points: [
                      [0.1, 0.1, 0.5],
                      [0.4, 0.12, 0.5],
                    ],
                    width: 0.004,
                    color: '#d1242f',
                  },
                ],
              },
            },
          ],
        },
      })
    ).json<{ id: string }[]>();
    const mark = {
      page: 2,
      rect: { x: 0.07, y: 0.07, w: 0.36, h: 0.08 },
      annotationIds: [drawing!.id],
      text: 'Pagina 2: la fotosintesis',
    };

    const events = await ask(thread.id, '', { context: { docId, currentPage: 2, mark } });
    expect(events.at(-1)).toMatchObject({ type: 'assistant_done' });

    // The prompt becomes a user message: the rendered area as an image, then the text.
    const prompt = calls[0]!.prompt as unknown as AsyncIterable<{
      message: { content: { type: string; text?: string; source?: { data: string } }[] };
    }>;
    const messages = [];
    for await (const m of prompt) messages.push(m);
    const [image, text] = messages[0]!.message.content;
    expect(image!.type).toBe('image');
    expect(Buffer.from(image!.source!.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(text!.text).toContain('freehand marks');
    expect(text!.text).toContain('Pagina 2: la fotosintesis');
    expect(text!.text).toContain('explain what the student marked');

    const history = (
      await app.inject({ url: `/api/threads/${thread.id}/messages`, headers })
    ).json<{ messages: ChatMessage[] }>().messages;
    expect(history[0]!.context?.mark).toMatchObject({ page: 2, annotationIds: [drawing!.id] });
  });

  it('asks about a mark without an image when its drawings are gone', async () => {
    const thread = (
      await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
    ).json<ThreadSummary>();
    const mark = { page: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.1 }, annotationIds: ['x'], text: '' };
    await ask(thread.id, '¿Esto?', { context: { docId, mark } });
    expect(typeof calls[0]!.prompt).toBe('string');
    expect(calls[0]!.prompt).toContain('freehand marks');
    expect(calls[0]!.prompt).not.toContain('attached to this message');
  });

  it('sends attached screenshots to Claude and keeps them with the question', async () => {
    const thread = (
      await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
    ).json<ThreadSummary>();
    const upload = async (color: string) => {
      const canvas = createCanvas(80, 40);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 80, 40);
      const dataUrl = `data:image/png;base64,${(await canvas.encode('png')).toString('base64')}`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/chat-images',
        headers,
        payload: { dataUrl },
      });
      expect(res.statusCode).toBe(201);
      return res.json<ChatImage>();
    };
    const first = await upload('#ff0000');
    const second = await upload('#00ff00');
    expect(first).toMatchObject({ width: 80, height: 40 });

    const events = await ask(thread.id, '', { imageIds: [second.id, first.id] });
    expect(events.at(-1)).toMatchObject({ type: 'assistant_done' });
    const prompt = calls[0]!.prompt as unknown as AsyncIterable<{
      message: { content: { type: string; text?: string; source?: { media_type: string } }[] };
    }>;
    const messages = [];
    for await (const m of prompt) messages.push(m);
    const blocks = messages[0]!.message.content;
    expect(blocks.map((b) => b.type)).toEqual(['image', 'image', 'text']);
    expect(blocks[0]!.source!.media_type).toBe('image/png');
    expect(blocks[2]!.text).toContain('attached 2 pictures');
    expect(blocks[2]!.text).toContain('explain what the attached picture shows');

    // Stored with the question, in the order sent, and served back.
    const echoed = events.find((e) => e.type === 'user_message');
    expect(echoed).toMatchObject({ message: { images: [{ id: second.id }, { id: first.id }] } });
    const history = (
      await app.inject({ url: `/api/threads/${thread.id}/messages`, headers })
    ).json<{ messages: ChatMessage[] }>().messages;
    expect(history[0]!.images?.map((i) => i.id)).toEqual([second.id, first.id]);
    const bytes = await app.inject({ url: `/api/chat-images/${first.id}`, headers });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/png');

    // A picture already sent (or unknown) cannot go with another question.
    const again = await ask(thread.id, '¿Y esto?', { imageIds: [first.id] });
    expect(again).toEqual([expect.objectContaining({ type: 'error', code: 'internal' })]);
    expect(calls).toHaveLength(1);

    // Deleting the conversation deletes its pictures.
    await app.inject({ method: 'DELETE', url: `/api/threads/${thread.id}`, headers });
    expect((await app.inject({ url: `/api/chat-images/${first.id}`, headers })).statusCode).toBe(
      404,
    );
  });

  it('sends attached files to Claude as text and lets it read them later', async () => {
    const thread = (
      await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
    ).json<ThreadSummary>();
    const upload = async (name: string, payload: Buffer) =>
      app.inject({
        method: 'POST',
        url: '/api/chat-files',
        headers: {
          ...headers,
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(name),
        },
        payload,
      });
    const pdfRes = await upload(
      'Tema 3 – mitosis.pdf',
      await makePdf([['La mitosis tiene cuatro fases.'], ['Profase y metafase.']]),
    );
    expect(pdfRes.statusCode).toBe(201);
    const pdf = pdfRes.json<ChatFile>();
    expect(pdf).toMatchObject({ name: 'Tema 3 – mitosis.pdf', kind: 'pdf', parts: 2 });
    const notes = (
      await upload('notas.md', Buffer.from('# Repaso\n\nLa meiosis da cuatro células.'))
    ).json<ChatFile>();
    expect(notes).toMatchObject({ kind: 'text', parts: 1 });
    const docx = (
      await upload('trabajo.docx', await makeDocx('El ciclo celular'))
    ).json<ChatFile>();
    expect(docx).toMatchObject({ kind: 'docx', parts: 1 });

    const events = await ask(thread.id, 'Compara', { fileIds: [pdf.id, notes.id, docx.id] });
    expect(events.at(-1)).toMatchObject({ type: 'assistant_done' });
    const prompt = calls[0]!.prompt;
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('The student attached 3 files');
    expect(prompt).toContain(
      `<file id="${pdf.id}" name="Tema 3 – mitosis.pdf" type="PDF, 2 pages">`,
    );
    expect(prompt).toContain('--- Page 2 ---\nProfase y metafase.');
    expect(prompt).toContain('La meiosis da cuatro células.');
    expect(prompt).toContain('**El ciclo celular**');
    expect(prompt).toContain('never cite them with [[cite:…]]');
    expect(calls[0]!.options.allowedTools).toContain('mcp__pca__read_attachment');

    // Kept with the question, served back, and listed to Claude in later questions.
    const history = (
      await app.inject({ url: `/api/threads/${thread.id}/messages`, headers })
    ).json<{ messages: ChatMessage[] }>().messages;
    expect(history[0]!.files?.map((f) => f.id)).toEqual([pdf.id, notes.id, docx.id]);
    const bytes = await app.inject({ url: `/api/chat-files/${docx.id}`, headers });
    expect(bytes.headers['content-disposition']).toContain("filename*=UTF-8''trabajo.docx");
    expect(bytes.headers['content-disposition']).toMatch(/^attachment/);
    await ask(thread.id, '¿Y la fase 2?');
    expect(calls[1]!.prompt).toContain('Files the student attached earlier');
    expect(calls[1]!.prompt).toContain(`id ${pdf.id}`);
    expect(calls[1]!.prompt).not.toContain('<file id=');

    // Claude's tools read files of this conversation only.
    const svc = servicesOf(app);
    const ctx: ToolContext = {
      threadId: thread.id,
      messageId: 'm',
      docId,
      scope: { kind: 'document', id: docId },
      emit: () => {},
      record: () => {},
    };
    const tools = attachmentTools(svc, ctx);
    const read = tools.find((x) => x.name === 'read_attachment')!;
    const page2 = (await read.handler({ fileId: pdf.id, from: 2, to: 5 } as never, {})) as {
      content: { text: string }[];
    };
    expect(page2.content[0]!.text).toContain('--- Page 2 ---\nProfase y metafase.');
    const image = tools.find((x) => x.name === 'get_attachment_page_image')!;
    const shot = (await image.handler({ fileId: pdf.id, page: 1 } as never, {})) as {
      content: { type: string }[];
    };
    expect(shot.content[0]!.type).toBe('image');
    const other = attachmentTools(svc, { ...ctx, threadId: 'another' });
    expect(await other[0]!.handler({ fileId: pdf.id, from: 1, to: 1 } as never, {})).toMatchObject({
      isError: true,
    });

    // Deleting the conversation deletes its files.
    await app.inject({ method: 'DELETE', url: `/api/threads/${thread.id}`, headers });
    expect((await app.inject({ url: `/api/chat-files/${pdf.id}`, headers })).statusCode).toBe(404);
  });

  it('refuses files it cannot read', async () => {
    const upload = (name: string, payload: Buffer) =>
      app.inject({
        method: 'POST',
        url: '/api/chat-files',
        headers: {
          ...headers,
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(name),
        },
        payload,
      });
    const binary = await upload('viejo.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 1, 2]));
    expect(binary.json()).toEqual({ error: 'unsupported_file' });
    const broken = await upload('roto.pdf', Buffer.from('%PDF-1.7 nothing else'));
    expect(broken.json()).toEqual({ error: 'unreadable_file' });
  });

  it('refuses files that are not pictures', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat-images',
      headers,
      payload: { dataUrl: `data:image/png;base64,${Buffer.from('nope').toString('base64')}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports usage limits as rate_limited and keeps the failed turn', async () => {
    script = async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 's',
        apiKeySource: 'none',
        model: 'fake',
      };
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } };
    };
    const thread = (
      await app.inject({ method: 'POST', url: `/api/documents/${docId}/threads`, headers })
    ).json<ThreadSummary>();
    const events = await ask(thread.id, 'Hola');
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'rate_limited' });
    expect((events.at(-1) as { message: ChatMessage }).message).toMatchObject({
      status: 'error',
      errorCode: 'rate_limited',
    });
  });

  it('refuses to run when Claude Code reports an API key', async () => {
    script = async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 's',
        apiKeySource: ['ANTHROPIC', 'API', 'KEY'].join('_'),
        model: 'fake',
      };
    };
    const thread = (
      await app.inject({ url: `/api/documents/${docId}/threads/active`, headers })
    ).json<ThreadSummary>();
    const events = await ask(thread.id, 'Hola');
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'auth_expired' });
  });
});

describe('reading tools', () => {
  const run = async (name: string, args: Record<string, unknown>) => {
    const seen: unknown[] = [];
    const ctx: ToolContext = {
      threadId: 't',
      messageId: 'm',
      docId,
      scope: { kind: 'document', id: docId },
      emit: (e) => seen.push(e),
      record: () => {},
    };
    const tools = readingTools(servicesOf(app), ctx);
    const t = tools.find((x) => x.name === name)!;
    const result = await t.handler(args as never, {});
    return { result, seen };
  };
  const textOf = (r: { content: { type: string; text?: string }[] }) =>
    r.content.map((c) => c.text ?? '').join('');

  it('reads at most 10 pages per call and reports progress', async () => {
    const { result, seen } = await run('get_pages', { docId, fromPage: 2, toPage: 20 });
    const out = textOf(result as never);
    expect(out).toContain('--- Page 2 ---');
    expect(out).toContain('--- Page 11 ---');
    expect(out).not.toContain('--- Page 12 ---');
    expect(out).toContain('Truncated at page 11');
    expect(seen).toMatchObject([
      { type: 'tool_event', event: { name: 'get_pages', summary: 'p. 2–20', status: 'running' } },
      { type: 'tool_event', event: { status: 'done' } },
    ]);
  });

  it('searches the open document and renders page images', async () => {
    const search = textOf(
      (await run('search_library', { query: 'Calvin', scope: 'doc' })).result as never,
    );
    expect(search).toContain(`(${docId}) p. 1`);
    expect(search).toContain('«Calvin»');

    const img = (await run('get_page_image', { docId, page: 1 })).result as {
      content: { type: string; mimeType?: string }[];
    };
    expect(img.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });

    const bad = (await run('get_pages', { docId: 'nope', fromPage: 1, toPage: 1 })).result;
    expect(bad).toMatchObject({ isError: true });
  });
});
