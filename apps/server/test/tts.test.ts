import type { AppSettings, TtsStatus } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../src/claude/prompt.js';
import { SupertonicTts } from '../src/services/tts.js';
import { chunkText, encodeWav, preprocess } from '../src/services/supertonic.js';
import { authedApp, servicesOf } from './helpers.js';

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
      payload: { text: '  Hola, ¿qué tal?  ', voice: 'm1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.body).toBe('RIFF-fake-m1');
    expect(calls.at(-1)).toEqual({ text: 'Hola, ¿qué tal?', voice: 'm1' });

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

  it('reports no server voice when Supertonic is not installed', async () => {
    const built = await authedApp({}, { synthesize: null });
    app = built.app;
    expect((await app.inject({ url: '/api/tts', headers: built.headers })).json()).toEqual({
      available: false,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      headers: built.headers,
      payload: { text: 'Hola', voice: 'm1' },
    });
    expect(res.statusCode).toBe(503);
    const log = { warn: () => {} } as never;
    expect(SupertonicTts.detect(null, log)).toBeNull();
    expect(SupertonicTts.detect('/nonexistent/supertonic-dir', log)).toBeNull();
  });

  it('keeps the chosen voice and speed in the settings', async () => {
    const built = await authedApp({}, { synthesize: null });
    app = built.app;
    const get = await app.inject({ url: '/api/settings', headers: built.headers });
    expect(get.json<AppSettings>().voice).toEqual({ voice: 'f1', rate: 1 });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: built.headers,
      payload: { voice: { voice: 'm1', rate: 1.2 } },
    });
    expect(res.json<AppSettings>().voice).toEqual({ voice: 'm1', rate: 1.2 });
  });

  it('maps a Piper voice saved before the switch to its Supertonic replacement', async () => {
    const built = await authedApp({}, { synthesize: null });
    app = built.app;
    servicesOf(app).settings.update({ voice: { voice: 'davefx' as never, rate: 1.1 } });
    const get = await app.inject({ url: '/api/settings', headers: built.headers });
    expect(get.json<AppSettings>().voice).toEqual({ voice: 'm1', rate: 1.1 });
  });

  it('prepares text for Supertonic', () => {
    expect(preprocess('Hola , ¿qué tal')).toBe('<es>Hola, ¿qué tal.</es>'.normalize('NFKD'));
    expect(preprocess('A → B — [nota] 😀 fin!')).toBe('<es>A B - nota fin!</es>');
    const long = `${'Frase corta. '.repeat(40)}Última.`;
    const chunks = chunkText(long, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(' ')).toBe(long.trim());
    expect(chunkText('Uno.\n\nDos.')).toEqual(['Uno.', 'Dos.']);
    const wav = encodeWav(Float32Array.of(0, 1, -1, 2), 44100);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(44100);
    expect([2, 3, 4, 5].map((i) => wav.readInt16LE(40 + i * 2))).toEqual([0, 32767, -32767, 32767]);
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
