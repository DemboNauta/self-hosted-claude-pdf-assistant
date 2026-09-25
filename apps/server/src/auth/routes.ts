import { verify } from '@node-rs/argon2';
import { loginRequestSchema, type SessionInfo } from '@pdfclaudeassistant/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { SESSION_COOKIE, SESSION_TTL_MS, type SessionStore } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    authenticated: boolean;
  }
}

/** Routes reachable without a session. Everything else under /api requires login. */
const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/auth/session', '/api/health']);

function readSessionToken(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

export async function registerAuth(
  app: FastifyInstance,
  config: AppConfig,
  sessions: SessionStore,
) {
  app.decorateRequest('authenticated', false);

  app.addHook('onRequest', async (req, reply) => {
    const token = readSessionToken(req);
    req.authenticated = token !== null && sessions.validate(token);
    const route = req.routeOptions.url ?? req.url.split('?')[0];
    const protectedRoute = route?.startsWith('/api/') || route?.startsWith('/ws/');
    if (!req.authenticated && protectedRoute && !PUBLIC_ROUTES.has(route!)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      signed: true,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = loginRequestSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const ok = await verify(config.passwordHash, body.data.password).catch(() => false);
      if (!ok) return reply.code(401).send({ error: 'invalid_password' });
      sessions.purgeExpired();
      setSessionCookie(reply, sessions.create(req.headers['user-agent']));
      return { authenticated: true } satisfies SessionInfo;
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const token = readSessionToken(req);
    if (token) sessions.revoke(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { authenticated: false } satisfies SessionInfo;
  });

  app.get(
    '/api/auth/session',
    async (req) => ({ authenticated: req.authenticated }) satisfies SessionInfo,
  );
}
