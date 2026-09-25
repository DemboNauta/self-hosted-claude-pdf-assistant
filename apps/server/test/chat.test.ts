import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ChatMessage,
  ServerChatEvent,
  ThreadSummary,
  UploadSession,
} from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readingTools, type ToolContext } from '../src/claude/tools.js';
import type { Db } from '../src/db/client.js';
import type { IngestService } from '../src/ingest/service.js';
import type { LibraryService } from '../src/services/library.js';
import { SearchService } from '../src/services/search.js';
import { makePdf } from './fixtures/pdf.js';
import { authedApp } from './helpers.js';

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
      if (ev.type === 'assistant_done') resolve();
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
    const db = (app as unknown as { pcaDb: Db }).pcaDb;
    const { LibraryService } = await import('../src/services/library.js');
    const library = new LibraryService(db, {} as never) as LibraryService;
    const seen: unknown[] = [];
    const ctx: ToolContext = {
      threadId: 't',
      messageId: 'm',
      docId,
      emit: (e) => seen.push(e),
      record: () => {},
    };
    const tools = readingTools({ db, library, search: new SearchService(db) }, ctx);
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
