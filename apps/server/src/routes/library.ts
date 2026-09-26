import fs from 'node:fs';
import {
  createSubjectSchema,
  createTopicSchema,
  readingPositionSchema,
  reorderSchema,
  restoreDocumentSchema,
  searchQuerySchema,
  updateDocumentSchema,
  updateSubjectSchema,
  updateTopicSchema,
} from '@pdfclaudeassistant/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '../services/errors.js';
import type { RequestServices } from '../services/scope.js';
import { parse } from './validate.js';

const idParams = z.object({ id: z.string().min(1).max(64) });

export async function registerLibraryRoutes(app: FastifyInstance, svc: RequestServices) {
  const id = (params: unknown) => parse(idParams, params).id;
  const lib = (req: FastifyRequest) => svc(req).library;

  app.get('/api/library', async (req) => lib(req).tree());
  app.get('/api/search', async (req) =>
    svc(req).search.search(parse(searchQuerySchema, req.query)),
  );

  // Subjects (F-LIB-01)
  app.post('/api/subjects', async (req, reply) =>
    reply.code(201).send(lib(req).createSubject(parse(createSubjectSchema, req.body))),
  );
  app.patch('/api/subjects/:id', async (req, reply) => {
    lib(req).updateSubject(id(req.params), parse(updateSubjectSchema, req.body));
    return reply.code(204).send();
  });
  app.delete('/api/subjects/:id', async (req, reply) => {
    lib(req).deleteSubject(id(req.params));
    return reply.code(204).send();
  });
  app.post('/api/subjects/reorder', async (req, reply) => {
    lib(req).reorderSubjects(parse(reorderSchema, req.body).ids);
    return reply.code(204).send();
  });

  // Topics (F-LIB-01)
  app.post('/api/topics', async (req, reply) =>
    reply.code(201).send(lib(req).createTopic(parse(createTopicSchema, req.body))),
  );
  app.patch('/api/topics/:id', async (req, reply) => {
    lib(req).updateTopic(id(req.params), parse(updateTopicSchema, req.body));
    return reply.code(204).send();
  });
  app.delete('/api/topics/:id', async (req, reply) => {
    lib(req).deleteTopic(id(req.params));
    return reply.code(204).send();
  });
  app.post('/api/topics/reorder', async (req, reply) => {
    lib(req).reorderTopics(parse(reorderSchema, req.body).ids);
    return reply.code(204).send();
  });

  // Documents (F-LIB-02..04)
  app.get('/api/documents/:id', async (req) => lib(req).detail(id(req.params)));
  app.patch('/api/documents/:id', async (req, reply) => {
    lib(req).updateDocument(id(req.params), parse(updateDocumentSchema, req.body));
    return reply.code(204).send();
  });
  app.post('/api/documents/reorder', async (req, reply) => {
    lib(req).reorderDocuments(parse(reorderSchema, req.body).ids);
    return reply.code(204).send();
  });
  app.delete('/api/documents/:id', async (req, reply) => {
    lib(req).trashDocument(id(req.params));
    return reply.code(204).send();
  });
  app.put('/api/documents/:id/position', async (req, reply) => {
    lib(req).saveReadingPosition(id(req.params), parse(readingPositionSchema, req.body));
    return reply.code(204).send();
  });

  app.get('/api/documents/:id/file', async (req, reply) => {
    const row = lib(req).getLive(id(req.params));
    const stat = await fs.promises.stat(row.filePath).catch(() => null);
    if (!stat) throw notFound();
    // PDF.js fetches ranges on its own when the server advertises support; the full
    // stream is fine for a single user and keeps this route simple.
    return reply
      .header('content-type', 'application/pdf')
      .header('content-length', stat.size)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(fs.createReadStream(row.filePath));
  });

  app.get('/api/documents/:id/cover', async (req, reply) => {
    const docId = id(req.params);
    lib(req).getLive(docId);
    const file = lib(req).coverPath(docId);
    if (!fs.existsSync(file)) throw notFound();
    return reply
      .header('content-type', 'image/webp')
      .header('cache-control', 'private, max-age=86400')
      .send(fs.createReadStream(file));
  });

  // Trash
  app.get('/api/trash', async (req) => lib(req).listTrash());
  app.post('/api/trash/:id/restore', async (req, reply) => {
    lib(req).restoreDocument(id(req.params), parse(restoreDocumentSchema, req.body).topicId);
    return reply.code(204).send();
  });
  app.delete('/api/trash', async (req, reply) => {
    lib(req).emptyTrash();
    return reply.code(204).send();
  });
  app.delete('/api/trash/:id', async (req, reply) => {
    lib(req).purgeDocument(id(req.params));
    return reply.code(204).send();
  });
}
