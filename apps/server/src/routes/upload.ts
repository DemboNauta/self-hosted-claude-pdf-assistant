import type { Readable } from 'node:stream';
import {
  createUploadSchema,
  importUrlSchema,
  uploadChunkQuerySchema,
} from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { userOf } from '../auth/routes.js';
import { OffsetMismatch, type UploadService } from '../services/uploads.js';
import { parse } from './validate.js';

const idParams = z.object({ id: z.string().min(1).max(64) });

/** Resumable chunked PDF uploads (F-ING-01); see UploadService. */
export async function registerUploadRoutes(app: FastifyInstance, uploads: UploadService) {
  const id = (params: unknown) => parse(idParams, params).id;

  await app.register(async (scope) => {
    // Chunks arrive as raw bytes and are streamed to disk; UploadService enforces the size.
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
      done(null, payload),
    );

    scope.post('/api/uploads', async (req, reply) =>
      reply.code(201).send(uploads.create(userOf(req).id, parse(createUploadSchema, req.body))),
    );
    scope.get('/api/uploads/:id', async (req) => uploads.status(userOf(req).id, id(req.params)));
    scope.put('/api/uploads/:id', async (req, reply) => {
      const uploadId = id(req.params);
      const { offset } = parse(uploadChunkQuerySchema, req.query);
      try {
        return await uploads.appendChunk(userOf(req).id, uploadId, offset, req.body as Readable);
      } catch (err) {
        if (err instanceof OffsetMismatch) {
          return reply.code(409).send({ error: err.code, received: err.received });
        }
        throw err;
      }
    });
    scope.post('/api/uploads/:id/complete', async (req, reply) =>
      reply.code(201).send(await uploads.complete(userOf(req).id, id(req.params))),
    );
    scope.post('/api/documents/import-url', async (req, reply) => {
      const { topicId, url } = parse(importUrlSchema, req.body);
      return reply.code(201).send(await uploads.importUrl(userOf(req).id, topicId, url));
    });
    scope.delete('/api/uploads/:id', async (req, reply) => {
      await uploads.cancel(userOf(req).id, id(req.params));
      return reply.code(204).send();
    });
  });
}
