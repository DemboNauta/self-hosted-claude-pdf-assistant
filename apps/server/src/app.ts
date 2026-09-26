import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { query } from '@anthropic-ai/claude-agent-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth/routes.js';
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
import { LibraryService } from './services/library.js';
import { SearchService } from './services/search.js';
import { ThreadService } from './services/threads.js';
import { AnnotationService } from './services/annotations.js';
import { SettingsService } from './services/settings.js';
import { MemoryService } from './services/memory.js';
import { ReviewService } from './services/review.js';
import { BriefService } from './services/brief.js';
import { StatsService } from './services/stats.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerAnnotationRoutes } from './routes/annotations.js';
import { registerDiagramRoutes } from './routes/diagrams.js';
import { DiagramService } from './services/diagrams.js';
import { registerFocusRoutes } from './routes/focus.js';
import { FocusService } from './services/focus.js';
import { UploadService } from './services/uploads.js';

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
  await registerAuth(app, config, new SessionStore(db), deps.loginAttemptsPerMinute);

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
  const search = new SearchService(db);
  await registerLibraryRoutes(app, library, search);
  await registerPdfjsAssets(app);
  const ocr = deps.ocr !== undefined ? deps.ocr : await detectOcr(config.ocrLangs);
  if (!ocr) app.log.info('ocrmypdf not found: scanned PDFs will be indexed without OCR');
  const ingest = new IngestService(db, library, app.log, ocr);
  app.decorate('pcaIngest', ingest);
  const uploads = new UploadService(
    config,
    library,
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

  const threads = new ThreadService(db);
  const annotations = new AnnotationService(db);
  const settings = new SettingsService(db);
  const memory = new MemoryService(db);
  await registerMemoryRoutes(app, memory);
  const review = new ReviewService(db);
  const brief = new BriefService(
    db,
    config,
    review,
    memory,
    library,
    settings,
    deps.claudeQuery ?? query,
  );
  await registerReviewRoutes(app, review, brief, new StatsService(db, library));
  await registerAnnotationRoutes(app, annotations, library, settings, db, config);
  const diagrams = new DiagramService(db);
  await registerDiagramRoutes(app, diagrams, library);
  await registerFocusRoutes(app, new FocusService(db));
  const chat = new ChatService(
    config,
    threads,
    library,
    { db, library, search, annotations, settings, memory, review, diagrams },
    claudeStatus,
    app.log,
    deps.claudeQuery ?? query,
    (docId) => memory.contextFor(docId),
  );
  await registerChatRoutes(app, threads, library, chat);
  if (config.webDir) await registerWebApp(app, config.webDir);

  app.addHook('onClose', async () => {
    clearInterval(purgeTimer);
    clearInterval(uploadsTimer);
    chat.stopAll();
    db.$client.close();
  });
  return app;
}
