import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { userOf } from '../auth/routes.js';
import type { ClaudeCredentials } from '../claude/credentials.js';
import type { ClaudeStatusService } from '../claude/status.js';

const statusQuery = z.object({ refresh: z.enum(['0', '1']).optional() });

/** The logged-in user's own Claude connection (Settings → "Conexión con Claude"). */
export async function registerClaudeRoutes(
  app: FastifyInstance,
  status: ClaudeStatusService,
  credentials: ClaudeCredentials,
) {
  app.get('/api/claude/status', async (req, reply) => {
    const q = statusQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    const { id } = userOf(req);
    return status.get(id, credentials.forUser(id), q.data.refresh === '1');
  });
}
