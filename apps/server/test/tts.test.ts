import type { AppSettings, TtsStatus } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../src/claude/prompt.js';
import { PiperTts } from '../src/services/tts.js';
import { authedApp } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(() => app?.close());

const calls: { text: string; voice: string }[] = [];
const fakeSynth = async (text: string, voice: string) => {
  calls.push({ text, voice });
  return Buffer.from(`RIFF-fake-${voice}`);
};

describe('voice mode (F-CHAT-09)', () => {
  it('synthesises one sentence with the chosen voice', async () => {
    const built = await authedApp({}, { synthesize: fakeSynth });
    app = built.app;
    const status = await app.inject({ url: '/api/tts', headers: built.headers });
    expect(status.json<TtsStatus>()).toEqual({ available: true });

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      headers: built.headers,
      payload: { text: '  Hola, ¿qué tal?  ', voice: 'davefx' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.body).toBe('RIFF-fake-davefx');
    expect(calls.at(-1)).toEqual({ text: 'Hola, ¿qué tal?', voice: 'davefx' });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/tts',
      headers: built.headers,
      payload: { text: 'x', voice: 'robot' },
    });
    expect(bad.statusCode).toBe(400);
    const anon = await app.inject({ method: 'POST', url: '/api/tts', payload: { text: 'x' } });
    expect(anon.statusCode).toBe(401);
  });

  it('reports no server voice when Piper is not installed', async () => {
    const built = await authedApp({}, { synthesize: null });
    app = built.app;
    expect((await app.inject({ url: '/api/tts', headers: built.headers })).json()).toEqual({
      available: false,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      headers: built.headers,
      payload: { text: 'Hola', voice: 'davefx' },
    });
    expect(res.statusCode).toBe(503);
    const log = { warn: () => {} } as never;
    expect(PiperTts.detect(null, log)).toBeNull();
    expect(PiperTts.detect('/nonexistent/piper-dir', log)).toBeNull();
  });

  it('keeps the chosen voice and speed in the settings', async () => {
    const built = await authedApp({}, { synthesize: null });
    app = built.app;
    const get = await app.inject({ url: '/api/settings', headers: built.headers });
    expect(get.json<AppSettings>().voice).toEqual({ voice: 'sharvard-f', rate: 1 });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: built.headers,
      payload: { voice: { voice: 'davefx', rate: 1.2 } },
    });
    expect(res.json<AppSettings>().voice).toEqual({ voice: 'davefx', rate: 1.2 });
  });

  it('asks Claude to teach out loud, and to answer interruptions briefly', () => {
    const prompt = buildTurnPrompt({
      text: '¿Y eso por qué?',
      mode: 'free',
      context: { docId: 'd1', voice: true, interruptedAfter: 'La clorofila absorbe luz.' },
      scope: ['Active document: "Bio" (id d1).'],
    });
    expect(prompt).toContain('Teach, do not read');
    expect(prompt).toContain('example or analogy');
    expect(prompt).toContain('The last thing they heard was: "La clorofila absorbe luz."');
    expect(prompt).toContain('Never ask whether to continue');
    const carryOn = buildTurnPrompt({
      text: 'Sigue explicando',
      mode: 'free',
      context: { docId: 'd1', voice: true, continueExplaining: true },
      scope: [],
    });
    expect(carryOn).toContain('Carry on with your spoken explanation');
    expect(carryOn).toContain('[[voice-end]]');
    const plain = buildTurnPrompt({
      text: 'Hola',
      mode: 'free',
      context: { docId: 'd1' },
      scope: [],
    });
    expect(plain).not.toContain('Voice mode');
  });
});
