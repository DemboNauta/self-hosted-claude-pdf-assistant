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
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../services/errors.js';
import type { LibraryService } from '../services/library.js';
import type { SearchService } from '../services/search.js';
import { parse } from './validate.js';

const idParams = z.object({ id: z.string().min(1).max(64) });

export async function registerLibraryRoutes(
  app: FastifyInstance,
  library: LibraryService,
  search: SearchService,
) {
  const id = (params: unknown) => parse(idParams, params).id;

  app.get('/api/library', async () => library.tree());
  app.get('/api/search', async (req) => search.search(parse(searchQuerySchema, req.query)));

  // Subjects (F-LIB-01)
  app.post('/api/subjects', async (req, reply) =>
    reply.code(201).send(library.createSubject(parse(createSubjectSchema, req.body))),
  );
  app.patch('/api/subjects/:id', async (req, reply) => {
    library.updateSubject(id(req.params), parse(updateSubjectSchema, req.body));
    return reply.code(204).send();
  });
  app.delete('/api/subjects/:id', async (req, reply) => {
    library.deleteSubject(id(req.params));
    return reply.code(204).send();
  });
  app.post('/api/subjects/reorder', async (req, reply) => {
    library.reorderSubjects(parse(reorderSchema, req.body).ids);
    return reply.code(204).send();
  });

  // Topics (F-LIB-01)
  app.post('/api/topics', async (req, reply) =>
    reply.code(201).send(library.createTopic(parse(createTopicSchema, req.body))),
  );
  app.patch('/api/topics/:id', async (req, reply) => {
    library.updateTopic(id(req.params), parse(updateTopicSchema, req.body));
    return reply.code(204).send();
  });
  app.delete('/api/topics/:id', async (req, reply) => {
    library.deleteTopic(id(req.params));
    return reply.code(204).send();
  });
  app.post('/api/topics/reorder', async (req, reply) => {
    library.reorderTopics(parse(reorderSchema, req.body).ids);
    return reply.code(204).send();
  });

  // Documents (F-LIB-02..04)
  app.get('/api/documents/:id', async (req) => library.detail(id(req.params)));
  app.patch('/api/documents/:id', async (req, reply) => {
    library.updateDocument(id(req.params), parse(updateDocumentSchema, req.body));
    return reply.code(204).send();
  });
  app.post('/api/documents/reorder', async (req, reply) => {
    library.reorderDocuments(parse(reorderSchema, req.body).ids);
    return reply.code(204).send();
  });
  app.delete('/api/documents/:id', async (req, reply) => {
    library.trashDocument(id(req.params));
    return reply.code(204).send();
  });
  app.put('/api/documents/:id/position', async (req, reply) => {
    library.saveReadingPosition(id(req.params), parse(readingPositionSchema, req.body));
    return reply.code(204).send();
  });

  app.get('/api/documents/:id/file', async (req, reply) => {
    const row = library.getLive(id(req.params));
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
    library.getLive(docId);
    const file = library.coverPath(docId);
    if (!fs.existsSync(file)) throw notFound();
    return reply
      .header('content-type', 'image/webp')
      .header('cache-control', 'private, max-age=86400')
      .send(fs.createReadStream(file));
  });

  // Trash
  app.get('/api/trash', async () => library.listTrash());
  app.post('/api/trash/:id/restore', async (req, reply) => {
    library.restoreDocument(id(req.params), parse(restoreDocumentSchema, req.body).topicId);
    return reply.code(204).send();
  });
  app.delete('/api/trash', async (_req, reply) => {
    library.emptyTrash();
    return reply.code(204).send();
  });
  app.delete('/api/trash/:id', async (req, reply) => {
    library.purgeDocument(id(req.params));
    return reply.code(204).send();
  });
}
