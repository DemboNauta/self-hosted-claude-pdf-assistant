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
  options: {
    mcpServers?: Record<string, { instance?: { _registeredTools?: FakeTools } }>;
    systemPrompt?: string;
  };
}) =>
  (async function* () {
    // Flashcards from read pages: one card per page it was shown.
    if (
      typeof args.prompt === 'string' &&
      args.options.systemPrompt?.includes('write flashcards')
    ) {
      const pages = args.prompt.matchAll(/--- (D\d+) p\. (\d+)[^\n]*\n([^\n]*)/g);
      const cards = [...pages].map((m) => ({
        ref: m[1],
        page: Number(m[2]),
        front: `¿Qué dice la página ${m[2]}?`,
        back: m[3]!.slice(0, 200),
        wrong: ['Opción falsa A', 'Opción falsa B', 'Opción falsa C'],
      }));
      yield { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(cards) };
      return;
    }
    // A hint for a card (its prompt also mentions "wrong options": check it first).
    if (typeof args.prompt === 'string' && args.options.systemPrompt?.includes('You give hints')) {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Pista de prueba.' };
      return;
    }
    // Wrong options for multiple choice: the same three for every card asked about.
    if (typeof args.prompt === 'string' && args.options.systemPrompt?.includes('wrong options')) {
      const refs = [...args.prompt.matchAll(/--- (C\d+) ---/g)].map((m) => ({
        ref: m[1],
        wrong: ['Opción falsa A', 'Opción falsa B', 'Opción falsa C'],
      }));
      yield { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(refs) };
      return;
    }
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
    // "Nota al margen" makes the fake propose a margin note on the selection.
    if (/nota al margen/i.test(question) && tools?.add_margin_notes && selected?.[2]) {
      await tools.add_margin_notes.handler(
        {
          notes: [
            { page: Number(page), quote: selected[2], text: 'Ojo: esto ocurre en el estroma.' },
          ],
        },
        {},
      );
    }
    // Marks drawn with point_at, referenced in the answer as Claude is told to.
    const markIds: string[] = [];
    const noteMark = (result: unknown) => {
      const id = /\[\[mark:([mw]\d+)\]\]/.exec(JSON.stringify(result))?.[1];
      if (id) markIds.push(id);
    };
    // "Revisa … pizarra" makes the fake look at the board and write a correction in red.
    let boardSeen = '';
    if (/revisa/i.test(question) && tools?.whiteboard_view && tools.whiteboard_draw) {
      const view = JSON.stringify(await tools.whiteboard_view.handler({}, {}));
      const at = /x (-?\d+) to (-?\d+) and y (-?\d+) to (-?\d+)/.exec(view);
      if (at) {
        boardSeen = 'He mirado tu pizarra. ';
        noteMark(
          await tools.whiteboard_draw.handler(
            {
              elements: [
                {
                  type: 'text',
                  x: Number(at[1]),
                  y: Number(at[4]) + 20,
                  text: 'Revisa este paso',
                  color: 'red',
                },
              ],
            },
            {},
          ),
        );
      } else boardSeen = 'Tu pizarra está vacía. ';
    }
    // "Pizarra" makes the fake draw on the whiteboard: two boxes, then an arrow between them.
    else if (/pizarra/i.test(question) && tools?.whiteboard_draw) {
      noteMark(
        await tools.whiteboard_draw.handler(
          {
            elements: [
              {
                type: 'rect',
                id: 'luz',
                x: 60,
                y: 40,
                w: 180,
                h: 70,
                label: 'Luz',
                color: 'orange',
              },
              { type: 'rect', id: 'azucar', x: 420, y: 40, w: 180, h: 70, label: 'Azúcar' },
            ],
          },
          {},
        ),
      );
      noteMark(
        await tools.whiteboard_draw.handler(
          {
            elements: [
              { type: 'arrow', from: 'luz', to: 'azucar', label: 'fotosíntesis', color: 'green' },
              { type: 'text', x: 60, y: 160, text: 'CO₂ + H₂O → glucosa + O₂', size: 'l' },
            ],
          },
          {},
        ),
      );
    }
    // "Conecta" makes the fake draw an arrow from the selection to the top of the page.
    if (/conecta/i.test(question) && tools?.point_at && quote) {
      noteMark(
        await tools.point_at.handler(
          {
            page: Number(page),
            shapes: [
              {
                type: 'arrow',
                anchor: { kind: 'text', quote },
                to: { kind: 'rect', x: 0.6, y: 0.05, w: 0.2, h: 0.05 },
              },
            ],
          },
          {},
        ),
      );
    }
    if (/señala/i.test(question) && tools?.point_at && quote) {
      noteMark(
        await tools.point_at.handler(
          {
            page: Number(page),
            shapes: [
              { type: 'circle', anchor: { kind: 'text', quote }, label: 'Aquí' },
              { type: 'arrow', anchor: { kind: 'text', quote } },
            ],
          },
          {},
        ),
      );
    }
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'e2e-session',
      model: 'claude-e2e',
      apiKeySource: 'none',
    };
    // Diagram mode: save a small mind map with the real tool and show it in the answer.
    let diagram = '';
    if (prompt.includes('Mode "Diagram"') && tools?.create_diagram) {
      const range = /Scope: pages? (\d+)(?: to (\d+))?/.exec(prompt);
      const result = JSON.stringify(
        await tools.create_diagram.handler(
          {
            title: 'Esquema de prueba',
            mermaid: 'mindmap\n  root((Fotosintesis))\n    Fase luminosa\n    Ciclo de Calvin',
            ...(range ? { fromPage: Number(range[1]), toPage: Number(range[2] ?? range[1]) } : {}),
          },
          {},
        ),
      );
      const id = /Saved diagram ([0-9a-z]+)/.exec(result)?.[1];
      if (id) diagram = `[[diagram:${id}]]\n\n`;
    }
    // A drawing mark: say whether the image of the marked area came with the question.
    const marked = /freehand marks[^\n]* on page (\d+)/.exec(prompt);
    // Voice mode (F-CHAT-09): a spoken explanation, or a short answer to an interruption.
    const voiceParts = prompt.includes('The student interrupted')
      ? ['Buena pregunta. ', 'La clorofila es el pigmento verde que capta la luz del sol.']
      : prompt.includes('Carry on with your spoken explanation')
        ? [
            'Seguimos con la segunda idea: la energía se guarda como azúcar. ',
            'Y con esto hemos terminado el tema. [[voice-end]]',
          ]
        : prompt.includes('Voice mode:')
          ? [
              'Vamos a verlo con un ejemplo sencillo de la vida diaria. ',
              'Imagina que la hoja es una pequeña cocina que funciona con luz. ',
              `Eso es justo lo que cuenta la página ${page} ${cite}. `,
              'Al final, la planta guarda esa energía en forma de azúcar.',
            ]
          : null;
    const parts = voiceParts ?? [
      ...(diagram ? [diagram] : []),
      ...(marked
        ? [`Veo tu marca en la página ${marked[1]}${image ? ' (con imagen)' : ''}. `]
        : []),
      ...(boardSeen ? [boardSeen] : []),
      ...markIds.map((id) => `[[mark:${id}]] Mira lo que te señalo. `),
      'Respuesta de prueba: ',
      'la idea principal está en la página ',
      `${page} ${cite}.`,
      '\n\nFórmula: $E = mc^2$',
      // "Larga" streams a long answer, to test reading while Claude writes.
      ...(/larga/i.test(question)
        ? Array.from({ length: 40 }, (_, i) => `\n\nPárrafo ${i + 1} de una respuesta larga.`)
        : []),
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

/** Fake voice: silent WAV audio, about as long as reading the text would take. */
function silentWav(text: string) {
  const rate = 8000;
  const samples = Math.round((rate * Math.min(4000, text.length * 40)) / 1000);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

const app = await buildApp(config, {
  logger: false,
  synthesize: async (text) => silentWav(text),
  loginAttemptsPerMinute: 1000,
  claudeQuery: fakeChat,
  claudeStatus: new ClaudeStatusService(config, fakeQuery),
});
await app.listen({ host: '127.0.0.1', port: config.port });
console.log(`e2e server on :${config.port} (data: ${dataDir})`);
