import type { FastifyInstance } from 'fastify';
import type { MemoryService } from '../services/memory.js';

/** Read-only memory view (F-MEM-05): the UI never edits what Claude remembers. */
export async function registerMemoryRoutes(app: FastifyInstance, memory: MemoryService) {
  app.get('/api/memory', async () => memory.overview());
}
