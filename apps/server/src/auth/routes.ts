import {
  acceptInvitationSchema,
  adminUpdateUserSchema,
  changePasswordSchema,
  claudeTokenSchema,
  createInvitationSchema,
  createUserSchema,
  loginRequestSchema,
  updateProfileSchema,
  type InvitationCheck,
  type SessionInfo,
} from '@pdfclaudeassistant/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { parse } from '../routes/validate.js';
import { HttpError } from '../services/errors.js';
import type { UserService } from '../services/users.js';
import { SESSION_COOKIE, SESSION_TTL_MS, type SessionStore, type SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The logged-in account; null on public routes without a session. */
    user: SessionUser | null;
  }
}

/** Routes reachable without a session. Everything else under /api requires login. */
const PUBLIC_ROUTES = new Set([
  '/api/auth/login',
  '/api/auth/session',
  '/api/auth/signup',
  '/api/auth/invitations/:token',
  '/api/health',
]);

const idParams = z.object({ id: z.string().min(1).max(64) });
const tokenParams = z.object({ token: z.string().min(1).max(128) });

function readSessionToken(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

/** The logged-in account of a protected route (the guard already rejected anonymous ones). */
export function userOf(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, 'unauthorized');
  return req.user;
}

export async function registerAuth(
  app: FastifyInstance,
  config: AppConfig,
  sessions: SessionStore,
  users: UserService,
  loginAttemptsPerMinute = 5,
  onClaudeTokenChange: (userId: string) => void = () => {},
) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    const token = readSessionToken(req);
    req.user = token === null ? null : sessions.validate(token);
    const route = req.routeOptions.url ?? req.url.split('?')[0];
    const protectedRoute = route?.startsWith('/api/') || route?.startsWith('/ws/');
    if (!req.user && protectedRoute && !PUBLIC_ROUTES.has(route!)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (route?.startsWith('/api/admin/') && req.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden' });
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

  const startSession = (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    sessions.purgeExpired();
    setSessionCookie(reply, sessions.create(userId, req.headers['user-agent']));
    return { authenticated: true, user: users.current(userId) } satisfies SessionInfo;
  };

  const limited = {
    config: { rateLimit: { max: loginAttemptsPerMinute, timeWindow: '1 minute' } },
  };

  app.post('/api/auth/login', limited, async (req, reply) => {
    const body = loginRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const user = await users.authenticate(body.data.username, body.data.password);
    if (!user) return reply.code(401).send({ error: 'invalid_credentials' });
    return startSession(req, reply, user.id);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = readSessionToken(req);
    if (token) sessions.revoke(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { authenticated: false } satisfies SessionInfo;
  });

  app.get('/api/auth/session', async (req) =>
    req.user
      ? ({ authenticated: true, user: users.current(req.user.id) } satisfies SessionInfo)
      : ({ authenticated: false } satisfies SessionInfo),
  );

  // Sign-up through an invitation link.
  app.get(
    '/api/auth/invitations/:token',
    limited,
    async (req) =>
      ({
        valid: users.checkInvitation(parse(tokenParams, req.params).token),
      }) satisfies InvitationCheck,
  );
  app.post('/api/auth/signup', limited, async (req, reply) => {
    const user = await users.acceptInvitation(parse(acceptInvitationSchema, req.body));
    return reply.code(201).send(startSession(req, reply, user.id));
  });

  // Own account.
  app.get('/api/account', async (req) => users.current(userOf(req).id));
  app.patch('/api/account', async (req) =>
    users.updateProfile(userOf(req).id, parse(updateProfileSchema, req.body)),
  );
  app.post('/api/account/password', limited, async (req, reply) => {
    const { currentPassword, newPassword } = parse(changePasswordSchema, req.body);
    await users.changePassword(
      userOf(req).id,
      currentPassword,
      newPassword,
      readSessionToken(req) ?? undefined,
    );
    return reply.code(204).send();
  });
  app.put('/api/account/claude-token', async (req) => {
    const { id } = userOf(req);
    users.setClaudeToken(id, parse(claudeTokenSchema, req.body).token);
    onClaudeTokenChange(id);
    return users.current(id);
  });
  app.delete('/api/account/claude-token', async (req) => {
    const { id } = userOf(req);
    users.setClaudeToken(id, null);
    onClaudeTokenChange(id);
    return users.current(id);
  });

  // Administration (the admin guard is in the onRequest hook above).
  const id = (params: unknown) => parse(idParams, params).id;
  app.get('/api/admin/users', async () => users.list());
  app.post('/api/admin/users', async (req, reply) =>
    reply.code(201).send(await users.create(parse(createUserSchema, req.body))),
  );
  app.patch('/api/admin/users/:id', async (req) =>
    users.adminUpdate(id(req.params), parse(adminUpdateUserSchema, req.body)),
  );
  app.delete('/api/admin/users/:id', async (req, reply) => {
    users.delete(id(req.params));
    return reply.code(204).send();
  });
  app.get('/api/admin/invitations', async () => users.invitations());
  app.post('/api/admin/invitations', async (req, reply) =>
    reply
      .code(201)
      .send(users.createInvitation(userOf(req).id, parse(createInvitationSchema, req.body).note)),
  );
  app.delete('/api/admin/invitations/:id', async (req, reply) => {
    users.deleteInvitation(id(req.params));
    return reply.code(204).send();
  });
}
