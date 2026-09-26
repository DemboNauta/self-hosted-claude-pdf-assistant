import type { FastifyInstance } from 'fastify';
import type { RequestServices } from '../services/scope.js';

/** Read-only memory view (F-MEM-05): the UI never edits what Claude remembers. */
export async function registerMemoryRoutes(app: FastifyInstance, svc: RequestServices) {
  app.get('/api/memory', async (req) => svc(req).memory.overview());
}
