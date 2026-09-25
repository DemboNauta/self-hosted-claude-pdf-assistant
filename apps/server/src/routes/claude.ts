import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ClaudeStatusService } from '../claude/status.js';

const statusQuery = z.object({ refresh: z.enum(['0', '1']).optional() });

export async function registerClaudeRoutes(app: FastifyInstance, status: ClaudeStatusService) {
  app.get('/api/claude/status', async (req, reply) => {
    const q = statusQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    return status.get(q.data.refresh === '1');
  });
}
