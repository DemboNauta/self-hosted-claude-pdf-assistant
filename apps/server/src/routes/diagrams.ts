import { updateDiagramSchema } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RequestServices } from '../services/scope.js';
import { parse } from './validate.js';

const idParams = z.object({ id: z.string().min(1).max(64) });

/** Claude's visual schemas: per document, all of them, rename and delete. */
export async function registerDiagramRoutes(app: FastifyInstance, svc: RequestServices) {
  const id = (params: unknown) => parse(idParams, params).id;

  app.get('/api/diagrams', async (req) => svc(req).diagrams.list());
  app.get('/api/documents/:id/diagrams', async (req) => {
    const docId = id(req.params);
    svc(req).library.getLive(docId);
    return svc(req).diagrams.list(docId);
  });
  app.get('/api/diagrams/:id', async (req) => svc(req).diagrams.get(id(req.params)));
  app.patch('/api/diagrams/:id', async (req) =>
    svc(req).diagrams.update(id(req.params), parse(updateDiagramSchema, req.body)),
  );
  app.delete('/api/diagrams/:id', async (req, reply) => {
    svc(req).diagrams.delete(id(req.params));
    return reply.code(204).send();
  });
}
