/**
 * Server for Playwright e2e tests: fresh temp data dir, fixed password and a fake
 * Claude probe, so CI never needs (or spends) a real subscription session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash } from '@node-rs/argon2';
import { buildApp } from '../src/app.js';
import { assertNoApiKey } from '../src/auth-guard.js';
import { ClaudeStatusService } from '../src/claude/status.js';
import { loadConfig } from '../src/config.js';

assertNoApiKey();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfclaudeassistant-e2e-'));
const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  PORT: process.env.PORT ?? '3100',
  APP_PASSWORD_HASH: await hash(process.env.E2E_PASSWORD ?? 'e2e-password'),
  SESSION_SECRET: 'e2e'.repeat(16),
  CLAUDE_CODE_OAUTH_TOKEN: 'e2e-fake-token',
});

const fakeQuery = (() =>
  (async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-e2e', apiKeySource: 'oauth' };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
  })()) as never;

/**
 * Fake chat turn: streams a short answer citing page 1 of the active document (with
 * the selected text as quote when there is one), so the UI can be tested end to end.
 */
type FakeTools = Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;

/** A turn prompt with an image comes as a user message with content blocks. */
type FakePrompt =
  string | AsyncIterable<{ message: { content: { type: string; text?: string }[] } }>;

const fakeChat = ((args: {
  prompt: FakePrompt;
  options: { mcpServers?: Record<string, { instance?: { _registeredTools?: FakeTools } }> };
}) =>
  (async function* () {
    let prompt = '';
    let image = false;
    if (typeof args.prompt === 'string') prompt = args.prompt;
    else {
      for await (const m of args.prompt) {
        for (const block of m.message.content) {
          if (block.type === 'image') image = true;
          if (block.type === 'text') prompt += block.text ?? '';
        }
      }
    }
    const docId = /\(id ([0-9a-z]+)/.exec(prompt)?.[1] ?? 'unknown';
    const selected = /Selected text on page (\d+):\n"""\n([\s\S]*?)\n"""/.exec(prompt);
    const page = selected?.[1] ?? '1';
    const quote = selected?.[2]?.split(/\s+/).slice(0, 6).join(' ');
    const cite = `[[cite:${docId}:${page}${quote ? `|"${quote}"` : ''}]]`;
    // "Señala…" makes the fake call the real point_at tool, as Claude would.
    const tools = args.options.mcpServers?.pca?.instance?._registeredTools;
    const question = prompt.split('</context>')[1] ?? '';
    // "Tarjetas" makes the fake propose a flashcard about the selection.
    if (/tarjetas/i.test(question) && tools?.create_flashcards && selected?.[2]) {
      await tools.create_flashcards.handler(
        { cards: [{ front: '¿Qué dice este fragmento?', back: selected[2], page: Number(page) }] },
        {},
      );
    }
    // "Recuerda …" makes the fake save it in memory and mark a difficult concept.
    const remember = /recuerda (.+)/i.exec(question)?.[1]?.trim();
    if (remember && tools?.remember && tools.mark_concept_difficult) {
      await tools.remember.handler(
        { scope: 'global', category: 'preference', content: remember },
        {},
      );
      await tools.mark_concept_difficult.handler(
        { concept: 'Ciclo de Calvin', page: 1, evidence: 'Lo preguntó dos veces' },
        {},
      );
    }
    // "Ideas clave" makes the fake propose the selected text as a key idea.
    if (/ideas clave/i.test(question) && tools?.highlight_key_ideas && selected?.[2]) {
      await tools.highlight_key_ideas.handler(
        { highlights: [{ page: Number(page), quote: selected[2], reason: 'Idea central' }] },
        {},
      );
    }
    if (/señala/i.test(question) && tools?.point_at && quote) {
      await tools.point_at.handler(
        {
          page: Number(page),
          shapes: [
            { type: 'circle', anchor: { kind: 'text', quote }, label: 'Aquí' },
            { type: 'arrow', anchor: { kind: 'text', quote } },
          ],
        },
        {},
      );
    }
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'e2e-session',
      model: 'claude-e2e',
      apiKeySource: 'none',
    };
    // A drawing mark: say whether the image of the marked area came with the question.
    const marked = /freehand marks[^\n]* on page (\d+)/.exec(prompt);
    const parts = [
      ...(marked
        ? [`Veo tu marca en la página ${marked[1]}${image ? ' (con imagen)' : ''}. `]
        : []),
      'Respuesta de prueba: ',
      'la idea principal está en la página ',
      `${page} ${cite}.`,
      '\n\nFórmula: $E = mc^2$',
    ];
    yield {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    };
    for (const text of parts) {
      await new Promise((r) => setTimeout(r, 60));
      yield {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      };
    }
    yield { type: 'result', subtype: 'success', is_error: false, result: parts.join('') };
  })()) as never;

const app = await buildApp(config, {
  logger: false,
  loginAttemptsPerMinute: 1000,
  claudeQuery: fakeChat,
  claudeStatus: new ClaudeStatusService(config, fakeQuery),
});
await app.listen({ host: '127.0.0.1', port: config.port });
console.log(`e2e server on :${config.port} (data: ${dataDir})`);
