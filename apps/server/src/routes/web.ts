import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the built web app (SPA) from the same server, so the VPS only needs this
 * container behind its own Caddy. Hashed assets are cached forever; index.html and the
 * service worker are always revalidated; unknown non-API paths fall back to index.html.
 */
export async function registerWebApp(app: FastifyInstance, webDir: string) {
  const index = path.join(webDir, 'index.html');
  if (!fs.existsSync(index)) {
    app.log.warn(`WEB_DIR ${webDir} has no index.html: the web app is not served`);
    return;
  }
  await app.register(fastifyStatic, {
    root: webDir,
    wildcard: false,
    index: false,
    // Cache headers are set per file below.
    cacheControl: false,
    setHeaders: (res, file) => {
      const rel = path.relative(webDir, file).split(path.sep).join('/');
      res.header(
        'cache-control',
        rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });

  const html = fs.readFileSync(index);
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] ?? '';
    if (req.method !== 'GET' || url.startsWith('/api/') || url.startsWith('/ws/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // Files that exist are served by @fastify/static; anything else is a client route.
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(html);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });
}
