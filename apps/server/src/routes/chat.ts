import websocket from '@fastify/websocket';
import { clientChatEventSchema, type ServerChatEvent } from '@pdfclaudeassistant/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChatService } from '../claude/chat.js';
import { HttpError } from '../services/errors.js';
import type { LibraryService } from '../services/library.js';
import type { ThreadService } from '../services/threads.js';
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
  threads: ThreadService,
  library: LibraryService,
  chat: ChatService,
) {
  const id = (params: unknown) => parse(idParams, params).id;

  app.get('/api/documents/:id/threads', async (req) => {
    const docId = id(req.params);
    library.getLive(docId);
    return threads.listForDocument(docId);
  });
  /** The document's active thread (created on first use). */
  app.get('/api/documents/:id/threads/active', async (req) => {
    const docId = id(req.params);
    library.getLive(docId);
    return threads.active(docId);
  });
  app.post('/api/documents/:id/threads', async (req, reply) => {
    const docId = id(req.params);
    library.getLive(docId);
    return reply.code(201).send(threads.create(docId));
  });
  app.get('/api/threads/:id/messages', async (req) => {
    const threadId = id(req.params);
    return { running: chat.isRunning(threadId), messages: threads.messages(threadId) };
  });
  app.delete('/api/threads/:id', async (req, reply) => {
    const threadId = id(req.params);
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
      if (event.type === 'stop') return chat.stop(event.threadId);
      // The turn keeps running if the socket closes; its result is stored in the thread.
      chat.send(event, emit).catch((err: unknown) => {
        req.log.error(err);
        emit({ type: 'error', threadId: event.threadId, code: 'internal' });
      });
    });
  });
}
