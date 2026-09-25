import {
  bulkStatusSchema,
  createAnnotationsSchema,
  updateAnnotationSchema,
  updateSettingsSchema,
} from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AnnotationService } from '../services/annotations.js';
import { exportAnnotatedPdf } from '../services/export.js';
import type { LibraryService } from '../services/library.js';
import type { SettingsService } from '../services/settings.js';
import { parse } from './validate.js';

const idParams = z.object({ id: z.string().min(1).max(64) });
const idsBody = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(1000) });

/** Annotations CRUD, export and settings (F-ANN-*, SPEC §9). */
export async function registerAnnotationRoutes(
  app: FastifyInstance,
  annotations: AnnotationService,
  library: LibraryService,
  settings: SettingsService,
) {
  const id = (params: unknown) => parse(idParams, params).id;

  app.get('/api/documents/:id/annotations', async (req) => {
    const docId = id(req.params);
    library.getLive(docId);
    return annotations.list(docId);
  });
  app.post('/api/documents/:id/annotations', async (req, reply) => {
    const docId = id(req.params);
    library.getLive(docId);
    const { items, ids } = parse(createAnnotationsSchema, req.body);
    return reply.code(201).send(annotations.create(docId, items, { ids }));
  });
  app.patch('/api/annotations/:id', async (req) =>
    annotations.update(id(req.params), parse(updateAnnotationSchema, req.body)),
  );
  app.post('/api/annotations/status', async (req, reply) => {
    const { ids, status } = parse(bulkStatusSchema, req.body);
    annotations.setStatus(ids, status);
    return reply.code(204).send();
  });
  app.post('/api/annotations/delete', async (req, reply) => {
    annotations.delete(parse(idsBody, req.body).ids);
    return reply.code(204).send();
  });

  app.get('/api/documents/:id/export-annotated', async (req, reply) => {
    const docId = id(req.params);
    const row = library.getLive(docId);
    const bytes = await exportAnnotatedPdf(
      row.filePath,
      annotations.list(docId),
      settings.palette(),
    );
    const name = `${row.title.replace(/[^\p{L}\p{N} ._-]+/gu, '').trim() || 'documento'} (anotado).pdf`;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(Buffer.from(bytes));
  });

  app.get('/api/settings', async () => settings.all());
  app.patch('/api/settings', async (req) => settings.update(parse(updateSettingsSchema, req.body)));
}
