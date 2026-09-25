import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ClaudeStatusService } from '../src/claude/status.js';
import { TEST_PASSWORD, testConfig } from './helpers.js';

let app: FastifyInstance;

beforeEach(async () => {
  const config = await testConfig();
  const claudeStatus = new ClaudeStatusService(config, (() => {
    throw new Error('Claude must not be called in auth tests');
  }) as never);
  app = await buildApp(config, { logger: false, claudeStatus });
});
afterEach(() => app.close());

const login = (password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });

describe('auth', () => {
  it('exposes health without a session', async () => {
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });

  it('rejects protected routes without a session', async () => {
    expect((await app.inject('/api/claude/status')).statusCode).toBe(401);
  });

  it('rejects a wrong password', async () => {
    const res = await login('nope');
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
  });

  it('logs in, keeps the session and logs out', async () => {
    const res = await login(TEST_PASSWORD);
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'pdfclaudeassistant_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    const headers = { cookie: `${cookie!.name}=${cookie!.value}` };

    const session = await app.inject({ url: '/api/auth/session', headers });
    expect(session.json()).toEqual({ authenticated: true });

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    const after = await app.inject({ url: '/api/auth/session', headers });
    expect(after.json()).toEqual({ authenticated: false });
  });

  it('rate-limits login attempts', async () => {
    for (let i = 0; i < 5; i++) await login('nope');
    expect((await login(TEST_PASSWORD)).statusCode).toBe(429);
  });
});
