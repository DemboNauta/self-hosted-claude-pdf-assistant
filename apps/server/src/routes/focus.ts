import { recordFocusSchema } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import type { FocusService } from '../services/focus.js';
import { parse } from './validate.js';

/** Study timer (F-FOCUS-02). */
export async function registerFocusRoutes(app: FastifyInstance, focus: FocusService) {
  app.post('/api/focus-sessions', async (req, reply) => {
    focus.record(parse(recordFocusSchema, req.body));
    return reply.code(204).send();
  });
}
