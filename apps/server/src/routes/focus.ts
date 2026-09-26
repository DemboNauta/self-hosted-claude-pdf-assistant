import { recordFocusSchema } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import type { RequestServices } from '../services/scope.js';
import { parse } from './validate.js';

/** Study timer (F-FOCUS-02). */
export async function registerFocusRoutes(app: FastifyInstance, svc: RequestServices) {
  app.post('/api/focus-sessions', async (req, reply) => {
    svc(req).focus.record(parse(recordFocusSchema, req.body));
    return reply.code(204).send();
  });
}
