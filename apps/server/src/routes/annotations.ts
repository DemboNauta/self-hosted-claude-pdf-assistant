import {
  addNoteImageSchema,
  bulkStatusSchema,
  createAnnotationsSchema,
  saveBoardToPdfSchema,
  updateAnnotationSchema,
  updateSettingsSchema,
} from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { backupFileName, createBackup } from '../services/backup.js';
import { HttpError } from '../services/errors.js';
import { exportAnnotatedPdf } from '../services/export.js';
import { fromDataUrl, normalizeImage } from '../services/images.js';
import type { RequestServices } from '../services/scope.js';
import { parse } from './validate.js';

const idParams = z.object({ id: z.string().min(1).max(64) });
const idsBody = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(1000) });
const captionBody = z.object({ caption: z.string().trim().max(300).nullable() });

/** Room for a photo sent as a data URL (the browser shrinks big ones first). */
const IMAGE_BODY_LIMIT = 25 * 1024 * 1024;

/** Annotations CRUD, export and settings (F-ANN-*, SPEC §9). */
export async function registerAnnotationRoutes(
  app: FastifyInstance,
  svc: RequestServices,
  db: Db,
  config: AppConfig,
) {
  const id = (params: unknown) => parse(idParams, params).id;

  app.get('/api/documents/:id/annotations', async (req) => {
    const docId = id(req.params);
    svc(req).library.getLive(docId);
    return svc(req).annotations.list(docId);
  });
  app.post('/api/documents/:id/annotations', async (req, reply) => {
    const docId = id(req.params);
    svc(req).library.getLive(docId);
    const { items, ids } = parse(createAnnotationsSchema, req.body);
    return reply.code(201).send(svc(req).annotations.create(docId, items, { ids }));
  });
  app.patch('/api/annotations/:id', async (req) =>
    svc(req).annotations.update(id(req.params), parse(updateAnnotationSchema, req.body)),
  );
  app.post('/api/annotations/status', async (req, reply) => {
    const { ids, status } = parse(bulkStatusSchema, req.body);
    svc(req).annotations.setStatus(ids, status);
    return reply.code(204).send();
  });
  app.post('/api/annotations/delete', async (req, reply) => {
    svc(req).annotations.delete(parse(idsBody, req.body).ids);
    return reply.code(204).send();
  });

  // ---- pictures in notes and highlights ----
  app.post('/api/annotations/:id/images', { bodyLimit: IMAGE_BODY_LIMIT }, async (req, reply) => {
    const s = svc(req);
    const a = s.annotations.get(id(req.params));
    if (a.type !== 'note' && a.type !== 'highlight') throw new HttpError(400, 'invalid_request');
    const { dataUrl, caption } = parse(addNoteImageSchema, req.body);
    const img = await normalizeImage(fromDataUrl(dataUrl));
    s.media.addImage(a.documentId, a.id, img, { source: 'user', caption });
    return reply.code(201).send(s.annotations.get(a.id));
  });
  app.get('/api/note-images/:id', async (req, reply) => {
    const { data, mime } = svc(req).media.image(id(req.params));
    return reply
      .header('content-type', mime)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(data);
  });
  app.patch('/api/note-images/:id', async (req) => {
    const s = svc(req);
    const imageId = id(req.params);
    s.media.setCaption(imageId, parse(captionBody, req.body).caption);
    return s.annotations.get(s.media.imageOwner(imageId));
  });
  app.delete('/api/note-images/:id', async (req) => {
    const s = svc(req);
    const imageId = id(req.params);
    const owner = s.media.imageOwner(imageId);
    s.media.deleteImage(imageId);
    return s.annotations.get(owner);
  });

  // ---- whiteboards saved on the PDF ----
  app.post('/api/documents/:id/boards', async (req, reply) => {
    const s = svc(req);
    const docId = id(req.params);
    s.library.getLive(docId);
    const input = parse(saveBoardToPdfSchema, req.body);
    const copy = s.whiteboards.copy(input.threadId);
    const [note] = s.annotations.create(docId, [
      {
        type: 'note',
        page: input.page,
        color: input.color ?? 'blue',
        content: input.content ?? null,
        anchor: input.anchor,
      },
    ]);
    s.media.createBoard(docId, note!.id, copy);
    return reply.code(201).send(s.annotations.get(note!.id));
  });
  app.get('/api/boards/:id/snapshot', async (req, reply) => {
    const png = svc(req).media.boardSnapshot(id(req.params));
    if (!png) throw new HttpError(404, 'not_found');
    return reply.header('content-type', 'image/png').header('cache-control', 'no-cache').send(png);
  });

  app.get('/api/documents/:id/export-annotated', async (req, reply) => {
    const docId = id(req.params);
    const row = svc(req).library.getLive(docId);
    const bytes = await exportAnnotatedPdf(
      row.filePath,
      svc(req).annotations.list(docId),
      svc(req).settings.palette(),
    );
    const name = `${row.title.replace(/[^\p{L}\p{N} ._-]+/gu, '').trim() || 'documento'} (anotado).pdf`;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(Buffer.from(bytes));
  });

  app.get('/api/settings', async (req) => svc(req).settings.all());
  // The backup holds every user's data, so only the admin (the server owner) gets it.
  app.get('/api/backup', async (req, reply) => {
    if (req.user?.role !== 'admin') throw new HttpError(403, 'forbidden');
    const { stream } = await createBackup(db, config);
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${backupFileName()}"`)
      .send(stream);
  });
  app.patch('/api/settings', async (req) =>
    svc(req).settings.update(parse(updateSettingsSchema, req.body)),
  );
}
