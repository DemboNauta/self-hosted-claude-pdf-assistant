import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { query } from '@anthropic-ai/claude-agent-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth, userOf } from './auth/routes.js';
import { SessionStore } from './auth/sessions.js';
import { ChatService } from './claude/chat.js';
import { ClaudeStatusService } from './claude/status.js';
import type { AppConfig } from './config.js';
import { openDb, type Db } from './db/client.js';
import { loggerOptions } from './log.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerClaudeRoutes } from './routes/claude.js';
import { detectOcr, type OcrRunner } from './ingest/ocr.js';
import { IngestService } from './ingest/service.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerPdfjsAssets } from './routes/pdfjs-assets.js';
import { registerWebApp } from './routes/web.js';
import { registerUploadRoutes } from './routes/upload.js';
import { HttpError } from './services/errors.js';
import { purgeExpiredTrash } from './services/library.js';
import { servicesFactory, type RequestServices } from './services/scope.js';
import { UserService } from './services/users.js';
import { ClaudeCredentials } from './claude/credentials.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerAnnotationRoutes } from './routes/annotations.js';
import { registerDiagramRoutes } from './routes/diagrams.js';
import { registerFocusRoutes } from './routes/focus.js';
import { UploadService } from './services/uploads.js';
import { PiperTts, type Synthesize } from './services/tts.js';
import { registerTtsRoutes } from './routes/tts.js';

export interface AppDeps {
  db?: Db;
  claudeStatus?: ClaudeStatusService;
  logger?: boolean;
  /** Only the e2e server raises this: its tests log in many times per minute. */
  loginAttemptsPerMinute?: number;
  /** Tests only: allow URL imports from local addresses. */
  allowPrivateUrls?: boolean;
  /** OCR runner; defaults to ocrmypdf when installed (tests inject a fake). */
  ocr?: OcrRunner | null;
  /** Replaces the Agent SDK `query` (tests and the e2e server use a fake Claude). */
  claudeQuery?: typeof query;
  /** Speech synthesis; defaults to Piper when PIPER_DIR is complete (tests inject a fake). */
  synthesize?: Synthesize | null;
}

export async function buildApp(config: AppConfig, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger === false ? false : loggerOptions,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  const db = deps.db ?? openDb(config.dbPath);
  const claudeStatus = deps.claudeStatus ?? new ClaudeStatusService(config);
  const runQuery = deps.claudeQuery ?? query;

  const sessions = new SessionStore(db);
  const users = new UserService(db, config, sessions);
  users.syncAdminPassword();
  const credentials = new ClaudeCredentials(users);
  const servicesFor = servicesFactory(db, config, credentials, runQuery);
  const svc: RequestServices = (req) => servicesFor(userOf(req).id);

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { global: false });
  await registerAuth(app, config, sessions, users, deps.loginAttemptsPerMinute, (userId) =>
    claudeStatus.forget(userId),
  );

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
  app.decorate('pcaServicesFor', servicesFor);
  const purge = () => {
    const n = purgeExpiredTrash(db, config);
    if (n) app.log.info(`purged ${n} expired document(s) from the trash`);
  };
  purge();
  const purgeTimer = setInterval(purge, 6 * 60 * 60 * 1000).unref();

  app.get('/api/health', async () => ({ ok: true }));
  await registerClaudeRoutes(app, claudeStatus, credentials);
  await registerLibraryRoutes(app, svc);
  await registerPdfjsAssets(app);
  const ocr = deps.ocr !== undefined ? deps.ocr : await detectOcr(config.ocrLangs);
  if (!ocr) app.log.info('ocrmypdf not found: scanned PDFs will be indexed without OCR');
  const ingest = new IngestService(db, config, app.log, ocr);
  app.decorate('pcaIngest', ingest);
  const uploads = new UploadService(
    config,
    (userId) => servicesFor(userId).library,
    (docId) => ingest.enqueue(docId),
    deps.allowPrivateUrls,
  );
  await registerUploadRoutes(app, uploads);
  ingest.resume();
  const purgeUploads = () => {
    const n = uploads.purgeStale();
    if (n) app.log.info(`removed ${n} abandoned upload(s)`);
  };
  purgeUploads();
  const uploadsTimer = setInterval(purgeUploads, 6 * 60 * 60 * 1000).unref();

  await registerMemoryRoutes(app, svc);
  await registerReviewRoutes(app, svc);
  await registerAnnotationRoutes(app, svc, db, config);
  await registerDiagramRoutes(app, svc);
  await registerFocusRoutes(app, svc);
  const chat = new ChatService(config, credentials, claudeStatus, app.log, runQuery);
  await registerChatRoutes(app, svc, chat);
  const piper = deps.synthesize === undefined ? PiperTts.detect(config.piperDir, app.log) : null;
  await registerTtsRoutes(
    app,
    deps.synthesize !== undefined ? deps.synthesize : (piper?.synthesize ?? null),
  );
  if (config.webDir) await registerWebApp(app, config.webDir);

  app.addHook('onClose', async () => {
    clearInterval(purgeTimer);
    clearInterval(uploadsTimer);
    chat.stopAll();
    piper?.close();
    db.$client.close();
  });
  return app;
}
