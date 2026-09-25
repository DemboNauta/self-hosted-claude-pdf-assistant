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

  app.get('/api/health', async () => ({ ok: true }));
  await registerClaudeRoutes(app, claudeStatus);

  app.addHook('onClose', async () => db.$client.close());
  return app;
}
