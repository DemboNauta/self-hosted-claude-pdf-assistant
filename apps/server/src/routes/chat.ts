import websocket from '@fastify/websocket';
import {
  addChatImageSchema,
  clientChatEventSchema,
  MAX_CHAT_FILE_BYTES,
  type ServerChatEvent,
} from '@pdfclaudeassistant/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChatService } from '../claude/chat.js';
import { readChatFile } from '../services/chatFiles.js';
import { HttpError } from '../services/errors.js';
import { fromDataUrl, normalizeImage } from '../services/images.js';
import type { RequestServices } from '../services/scope.js';
import { parse } from './validate.js';

const idParams = z.object({ id: z.string().min(1).max(64) });

const chatFileHeaders = z.object({ name: z.string().trim().min(1).max(1000) });

/** The `x-file-name` header, URI-encoded by the browser (names can be in any script). */
function decodeName(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  try {
    return decodeURIComponent(value ?? '');
  } catch {
    return '';
  }
}

/** Room for a picture sent as a data URL (the browser shrinks big ones first). */
const IMAGE_BODY_LIMIT = 25 * 1024 * 1024;

/** Rejects cross-site WebSocket handshakes (cookies alone do not prove the page is ours). */
function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (tests)
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Threads REST API and the `/ws/chat` stream (F-CHAT-01, F-CHAT-07; SPEC §9). */
export async function registerChatRoutes(
  app: FastifyInstance,
  svc: RequestServices,
  chat: ChatService,
) {
  const id = (params: unknown) => parse(idParams, params).id;

  // Threads per document, topic or subject (F-CHAT-07/08).
  const scopes = [
    { path: 'documents', kind: 'document', check: 'getLive' },
    { path: 'topics', kind: 'topic', check: 'getTopicOrThrow' },
    { path: 'subjects', kind: 'subject', check: 'getSubjectOrThrow' },
  ] as const;
  for (const { path, kind, check } of scopes) {
    const scope = (req: FastifyRequest) => {
      const scopeId = id(req.params);
      svc(req).library[check](scopeId);
      return { kind, id: scopeId };
    };
    app.get(`/api/${path}/:id/threads`, async (req) => svc(req).threads.list(scope(req)));
    /** The active thread (created on first use). */
    app.get(`/api/${path}/:id/threads/active`, async (req) => svc(req).threads.active(scope(req)));
    app.post(`/api/${path}/:id/threads`, async (req, reply) =>
      reply.code(201).send(svc(req).threads.create(scope(req))),
    );
  }
  /** Questions asked about passages of a document, shown as marks on its pages. */
  app.get('/api/documents/:id/questions', async (req) => {
    const docId = id(req.params);
    const { library, threads } = svc(req);
    library.getLive(docId);
    return threads.documentQuestions(docId);
  });
  app.get('/api/threads/:id/messages', async (req) => {
    const threadId = id(req.params);
    const messages = svc(req).threads.messages(threadId);
    return { running: chat.isRunning(threadId), messages };
  });
  app.delete('/api/threads/:id', async (req, reply) => {
    const threadId = id(req.params);
    const { threads } = svc(req);
    threads.get(threadId);
    if (chat.isRunning(threadId)) throw new HttpError(409, 'busy');
    threads.delete(threadId);
    return reply.code(204).send();
  });

  // Pictures attached to questions (screenshots, photos): uploaded while the student
  // writes, then sent with the question by id.
  app.post('/api/chat-images', { bodyLimit: IMAGE_BODY_LIMIT }, async (req, reply) => {
    const { dataUrl } = parse(addChatImageSchema, req.body);
    const img = await normalizeImage(fromDataUrl(dataUrl));
    return reply.code(201).send(svc(req).chatImages.add(img));
  });
  app.get('/api/chat-images/:id', async (req, reply) => {
    const { data, mime } = svc(req).chatImages.image(id(req.params));
    return reply
      .header('content-type', mime)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(data);
  });

  // Files attached to questions (PDF, Word, text): raw bytes, the name in `x-file-name`
  // (URI-encoded). Claude reads their text; they never open in the reader.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_CHAT_FILE_BYTES + 1024 },
      (_req, body, done) => done(null, body),
    );
    scope.post('/api/chat-files', async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'invalid_request');
      const { name } = parse(chatFileHeaders, {
        name: decodeName(req.headers['x-file-name']),
      });
      const file = await readChatFile(req.body, name);
      return reply.code(201).send(svc(req).chatFiles.add(name, req.body, file));
    });
  });
  app.get('/api/chat-files/:id', async (req, reply) => {
    const { data, mime, name, kind } = svc(req).chatFiles.file(id(req.params));
    // A PDF opens in a browser tab; Word and text files are downloaded.
    const disposition = kind === 'pdf' ? 'inline' : 'attachment';
    return reply
      .header('content-type', mime)
      .header(
        'content-disposition',
        `${disposition}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(data);
  });

  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  app.get('/ws/chat', { websocket: true }, (socket, req) => {
    if (!sameOrigin(req)) {
      socket.close(1008, 'origin');
      return;
    }
    // The socket belongs to the account that opened it; every event runs as that user.
    const user = svc(req);
    const emit = (event: ServerChatEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };
    // Keeps proxies (Caddy, Cloudflare) from closing an idle connection.
    const ping = setInterval(() => socket.ping(), 30_000);
    socket.on('close', () => clearInterval(ping));

    socket.on('message', (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return emit({ type: 'error', code: 'internal', message: 'invalid_json' });
      }
      const parsed = clientChatEventSchema.safeParse(data);
      if (!parsed.success)
        return emit({ type: 'error', code: 'internal', message: 'invalid_request' });
      const event = parsed.data;
      if (event.type === 'stop') {
        try {
          user.threads.get(event.threadId);
        } catch {
          return;
        }
        return chat.stop(event.threadId);
      }
      // The turn keeps running if the socket closes; its result is stored in the thread.
      chat.send(user, event, emit).catch((err: unknown) => {
        req.log.error(err);
        emit({ type: 'error', threadId: event.threadId, code: 'internal' });
      });
    });
  });
}
