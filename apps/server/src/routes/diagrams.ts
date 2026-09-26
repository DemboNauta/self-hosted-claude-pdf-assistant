import { updateDiagramSchema } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DiagramService } from '../services/diagrams.js';
import type { LibraryService } from '../services/library.js';
import { parse } from './validate.js';

const idParams = z.object({ id: z.string().min(1).max(64) });

/** Claude's visual schemas: per document, all of them, rename and delete. */
export async function registerDiagramRoutes(
  app: FastifyInstance,
  diagrams: DiagramService,
  library: LibraryService,
) {
  const id = (params: unknown) => parse(idParams, params).id;

  app.get('/api/diagrams', async () => diagrams.list());
  app.get('/api/documents/:id/diagrams', async (req) => {
    const docId = id(req.params);
    library.getLive(docId);
    return diagrams.list(docId);
  });
  app.get('/api/diagrams/:id', async (req) => diagrams.get(id(req.params)));
  app.patch('/api/diagrams/:id', async (req) =>
    diagrams.update(id(req.params), parse(updateDiagramSchema, req.body)),
  );
  app.delete('/api/diagrams/:id', async (req, reply) => {
    diagrams.delete(id(req.params));
    return reply.code(204).send();
  });
}
