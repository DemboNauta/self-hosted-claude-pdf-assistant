import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth/routes.js';
import { SessionStore } from './auth/sessions.js';
import { ClaudeStatusService } from './claude/status.js';
import type { AppConfig } from './config.js';
import { openDb, type Db } from './db/client.js';
import { loggerOptions } from './log.js';
import { registerClaudeRoutes } from './routes/claude.js';
import { IngestService } from './ingest/service.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerUploadRoutes } from './routes/upload.js';
import { HttpError } from './services/errors.js';
import { LibraryService } from './services/library.js';
import { UploadService } from './services/uploads.js';

export interface AppDeps {
  db?: Db;
  claudeStatus?: ClaudeStatusService;
  logger?: boolean;
}

export async function buildApp(config: AppConfig, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger === false ? false : loggerOptions,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  const db = deps.db ?? openDb(config.dbPath);
  const claudeStatus = deps.claudeStatus ?? new ClaudeStatusService(config);

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { global: false });
  await registerAuth(app, config, new SessionStore(db));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as { code?: string }).code ?? 'bad_request' });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });

  // Exposed for tests that need to seed data below the HTTP layer.
  app.decorate('pcaDb', db);
  const library = new LibraryService(db, config);
  const purge = () => {
    const n = library.purgeExpiredTrash();
    if (n) app.log.info(`purged ${n} expired document(s) from the trash`);
  };
  purge();
  const purgeTimer = setInterval(purge, 6 * 60 * 60 * 1000).unref();

  app.get('/api/health', async () => ({ ok: true }));
  await registerClaudeRoutes(app, claudeStatus);
  await registerLibraryRoutes(app, library);
  const ingest = new IngestService(db, library, app.log);
  app.decorate('pcaIngest', ingest);
  const uploads = new UploadService(config, library, (docId) => ingest.enqueue(docId));
  await registerUploadRoutes(app, uploads);
  ingest.resume();
  const purgeUploads = () => {
    const n = uploads.purgeStale();
    if (n) app.log.info(`removed ${n} abandoned upload(s)`);
  };
  purgeUploads();
  const uploadsTimer = setInterval(purgeUploads, 6 * 60 * 60 * 1000).unref();

  app.addHook('onClose', async () => {
    clearInterval(purgeTimer);
    clearInterval(uploadsTimer);
    db.$client.close();
  });
  return app;
}
