import { ttsRequestSchema, type TtsStatus } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../services/errors.js';
import type { Synthesize } from '../services/tts.js';
import { parse } from './validate.js';

/** Claude's voice in voice mode (F-CHAT-09): one sentence in, WAV audio out. */
export async function registerTtsRoutes(app: FastifyInstance, synthesize: Synthesize | null) {
  app.get('/api/tts', async () => ({ available: synthesize !== null }) satisfies TtsStatus);

  app.post(
    '/api/tts',
    // Voice mode asks for one sentence at a time: generous, but not unbounded.
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!synthesize) throw new HttpError(503, 'tts_unavailable');
      const { text, voice } = parse(ttsRequestSchema, req.body);
      const audio = await synthesize(text, voice);
      return reply
        .header('content-type', 'audio/wav')
        .header('cache-control', 'private, max-age=3600')
        .send(audio);
    },
  );
}
