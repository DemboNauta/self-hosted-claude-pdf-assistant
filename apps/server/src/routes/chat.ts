import websocket from '@fastify/websocket';
import { clientChatEventSchema, type ServerChatEvent } from '@pdfclaudeassistant/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChatService } from '../claude/chat.js';
import { HttpError } from '../services/errors.js';
import type { RequestServices } from '../services/scope.js';
import { parse } from './validate.js';

const idParams = z.object({ id: z.string().min(1).max(64) });

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
