import fs from 'node:fs';
import { hash } from '@node-rs/argon2';
import type {
  AdminUser,
  CreatedInvitation,
  LibraryTree,
  ServerChatEvent,
  SessionInfo,
  ThreadSummary,
} from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ClaudeStatusService } from '../src/claude/status.js';
import { openDb } from '../src/db/client.js';
import { memoryTools, type ToolContext } from '../src/claude/tools.js';
import { authedApp, seedDocument, servicesOf, tempDataDir, testConfig } from './helpers.js';

interface FakeCall {
  prompt: unknown;
  options: { env: Record<string, string> };
}

let app: FastifyInstance;
let admin: Record<string, string>;
let calls: FakeCall[];

const fakeQuery = ((args: FakeCall) => {
  calls.push(args);
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's', apiKeySource: 'none', model: 'm' };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
  })();
}) as never;

beforeEach(async () => {
  calls = [];
  ({ app, headers: admin } = await authedApp(tempDataDir('pca-users-'), {
    claudeQuery: fakeQuery,
    loginAttemptsPerMinute: 1000,
  }));
});
afterEach(() => app.close());

const api = async <T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => {
  const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as T, res };
};

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === 'pdfclaudeassistant_session')!;
  return { cookie: `${c.name}=${c.value}` };
};

async function login(username: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  return res.statusCode === 200 ? cookieOf(res) : null;
}

async function createUser(username = 'ana', password = 'ana-password-1') {
  const created = await api<AdminUser>('POST', '/api/admin/users', admin, {
    username,
    password,
  });
  expect(created.status).toBe(201);
  return { id: created.body.id, headers: (await login(username, password))! };
}

describe('accounts', () => {
  it("keeps each user's library, documents and chats to themselves", async () => {
    const { docId, topicId, subjectId } = await seedDocument(app, admin, [['Secreto del admin.']]);
    const ana = await createUser();

    const tree = await api<LibraryTree>('GET', '/api/library', ana.headers);
    expect(tree.body.subjects).toEqual([]);
    for (const url of [
      `/api/documents/${docId}`,
      `/api/documents/${docId}/file`,
      `/api/documents/${docId}/annotations`,
      `/api/documents/${docId}/threads/active`,
      `/api/topics/${topicId}/threads`,
    ]) {
      // Unknown topics answer 400 unknown_topic, the rest 404: either way, nothing leaks.
      expect([400, 404], url).toContain((await api('GET', url, ana.headers)).status);
    }
    const search = await api<unknown[]>('GET', '/api/search?q=Secreto&scope=all', ana.headers);
    expect(search.body).toEqual([]);
    expect(
      (await api('PATCH', `/api/subjects/${subjectId}`, ana.headers, { name: 'X' })).status,
    ).toBe(404);
    expect(
      (await api('POST', '/api/topics', ana.headers, { subjectId, name: 'Intrusa' })).status,
    ).toBe(400);

    // The admin's thread cannot be read or deleted by Ana either.
    const thread = (
      await api<ThreadSummary>('GET', `/api/documents/${docId}/threads/active`, admin)
    ).body;
    expect((await api('GET', `/api/threads/${thread.id}/messages`, ana.headers)).status).toBe(404);
    expect((await api('DELETE', `/api/threads/${thread.id}`, ana.headers)).status).toBe(404);

    // Her own library works as usual, and the admin does not see it.
    await seedDocument(app, ana.headers, [['Apuntes de Ana.']]);
    expect((await api<LibraryTree>('GET', '/api/library', ana.headers)).body.subjects).toHaveLength(
      1,
    );
    expect((await api<LibraryTree>('GET', '/api/library', admin)).body.subjects).toHaveLength(1);
  });

  it("does not let Claude tools write into another user's documents", async () => {
    const { docId } = await seedDocument(app, admin, [['Texto.']]);
    const ana = await createUser();
    const ctx: ToolContext = {
      threadId: 't',
      messageId: 'm',
      scope: { kind: 'document', id: docId },
      emit: () => {},
      record: () => {},
    };
    const remember = memoryTools(servicesOf(app, ana.id), ctx).find((t) => t.name === 'remember')!;
    const result = await remember.handler(
      { scope: 'document', docId, category: 'progress', content: 'Leído hasta la p. 3' } as never,
      {},
    );
    expect(result).toMatchObject({ isError: true });
    expect(servicesOf(app).memory.overview().documents).toEqual([]);
  });

  it('keeps settings per user', async () => {
    const ana = await createUser();
    await api('PATCH', '/api/settings', ana.headers, { claudeModel: 'haiku' });
    expect(
      (await api<{ claudeModel: string }>('GET', '/api/settings', ana.headers)).body.claudeModel,
    ).toBe('haiku');
    expect(
      (await api<{ claudeModel: null }>('GET', '/api/settings', admin)).body.claudeModel,
    ).toBeNull();
  });

  it('reserves administration and backups for the admin', async () => {
    const ana = await createUser();
    expect((await api('GET', '/api/admin/users', ana.headers)).status).toBe(403);
    expect((await api('POST', '/api/admin/invitations', ana.headers, {})).status).toBe(403);
    expect((await api('GET', '/api/backup', ana.headers)).status).toBe(403);
    expect((await api('GET', '/api/admin/users', admin)).status).toBe(200);
  });

  it('rejects duplicate names and lets the admin disable, reset and delete accounts', async () => {
    const ana = await createUser();
    const dup = await api('POST', '/api/admin/users', admin, {
      username: 'ANA',
      password: 'whatever-123',
    });
    expect(dup.status).toBe(409);

    const { docId } = await seedDocument(app, ana.headers, [['Apuntes.']]);
    const file = servicesOf(app, ana.id).library.getLive(docId).filePath;

    await api('PATCH', `/api/admin/users/${ana.id}`, admin, { disabled: true });
    expect((await api('GET', '/api/library', ana.headers)).status).toBe(401);
    expect(await login('ana', 'ana-password-1')).toBeNull();

    await api('PATCH', `/api/admin/users/${ana.id}`, admin, {
      disabled: false,
      password: 'new-password-2',
    });
    expect(await login('ana', 'ana-password-1')).toBeNull();
    expect(await login('ana', 'new-password-2')).not.toBeNull();

    expect((await api('DELETE', `/api/admin/users/${ana.id}`, admin)).status).toBe(204);
    expect(fs.existsSync(file)).toBe(false);
    expect(await login('ana', 'new-password-2')).toBeNull();

    const self = (await api<SessionInfo>('GET', '/api/auth/session', admin)).body.user!;
    expect((await api('DELETE', `/api/admin/users/${self.id}`, admin)).status).toBe(409);
    expect(
      (await api('PATCH', `/api/admin/users/${self.id}`, admin, { disabled: true })).status,
    ).toBe(409);
  });

  it('changes the own password and logs out the other sessions', async () => {
    const ana = await createUser();
    const other = (await login('ana', 'ana-password-1'))!;
    const wrong = await api('POST', '/api/account/password', ana.headers, {
      currentPassword: 'nope',
      newPassword: 'another-pass-3',
    });
    expect(wrong.status).toBe(403);
    await api('POST', '/api/account/password', ana.headers, {
      currentPassword: 'ana-password-1',
      newPassword: 'another-pass-3',
    });
    expect((await api('GET', '/api/library', ana.headers)).status).toBe(200);
    expect((await api('GET', '/api/library', other)).status).toBe(401);
  });
});

describe('invitations', () => {
  it('signs up once through a link and logs the new user in', async () => {
    const inv = (
      await api<CreatedInvitation>('POST', '/api/admin/invitations', admin, { note: 'Para Luis' })
    ).body;
    expect(inv.token.length).toBeGreaterThan(20);
    const check = await app.inject({ url: `/api/auth/invitations/${inv.token}` });
    expect(check.json()).toEqual({ valid: true });

    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { token: inv.token, username: 'luis', password: 'luis-pass-1' },
    });
    expect(signup.statusCode).toBe(201);
    expect(signup.json<SessionInfo>().user).toMatchObject({ username: 'luis', role: 'user' });
    const luis = cookieOf(signup);
    expect((await api('GET', '/api/library', luis)).status).toBe(200);

    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { token: inv.token, username: 'otro', password: 'otro-pass-1' },
    });
    expect(again.statusCode).toBe(410);
    expect((await app.inject({ url: `/api/auth/invitations/${inv.token}` })).json()).toEqual({
      valid: false,
    });
    const list = await api<{ usedByUsername: string | null }[]>(
      'GET',
      '/api/admin/invitations',
      admin,
    );
    expect(list.body[0]?.usedByUsername).toBe('luis');
  });
});

describe('Claude per user', () => {
  it('needs a personal token for users other than the admin, and uses only theirs', async () => {
    const ana = await createUser();
    const status = await api<{ state: string }>('GET', '/api/claude/status', ana.headers);
    expect(status.body.state).toBe('not_configured');

    const ask = async () => {
      const { docId } = await seedDocument(app, ana.headers, [['Fotosíntesis.']]);
      const thread = (
        await api<ThreadSummary>('GET', `/api/documents/${docId}/threads/active`, ana.headers)
      ).body;
      const ws = await app.injectWS('/ws/chat', { headers: ana.headers });
      const events: ServerChatEvent[] = [];
      const done = new Promise<void>((resolve) =>
        ws.on('message', (raw) => {
          const ev = JSON.parse(String(raw)) as ServerChatEvent;
          events.push(ev);
          if (ev.type === 'assistant_done' || (ev.type === 'error' && !ev.messageId)) resolve();
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'user_message',
          threadId: thread.id,
          clientId: 'c',
          text: 'Hola',
          mode: 'free',
          context: { docId, currentPage: 1 },
        }),
      );
      await done;
      ws.terminate();
      return events;
    };

    expect((await ask()).find((e) => e.type === 'error')).toMatchObject({ code: 'not_configured' });
    expect(calls).toHaveLength(0);

    const token = 'sk-ant-oat01-' + 'a'.repeat(40);
    const saved = await api<{ hasClaudeToken: boolean }>(
      'PUT',
      '/api/account/claude-token',
      ana.headers,
      { token },
    );
    expect(saved.body.hasClaudeToken).toBe(true);
    // Stored encrypted, never in clear.
    const raw = servicesOf(app)
      .db.$client.prepare('SELECT claude_token_enc AS enc FROM users WHERE id = ?')
      .get(ana.id) as { enc: string };
    expect(raw.enc).not.toContain(token);

    expect((await ask()).find((e) => e.type === 'assistant_done')).toBeTruthy();
    const env = calls.at(-1)!.options.env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(env.CLAUDE_CONFIG_DIR).toContain(ana.id);
  });
});

describe('admin password', () => {
  it('comes from APP_PASSWORD_HASH and follows it when it changes', async () => {
    const dirs = tempDataDir('pca-adminpw-');
    const dbPath = `${dirs.dataDir}/pdfclaudeassistant.db`;
    const status = (config: Awaited<ReturnType<typeof testConfig>>) =>
      new ClaudeStatusService(config, (() => {
        throw new Error('no Claude');
      }) as never);
    const boot = async (password: string) => {
      const config = await testConfig({ ...dirs, dbPath, passwordHash: await hash(password) });
      return buildApp(config, { logger: false, db: openDb(dbPath), claudeStatus: status(config) });
    };
    const tryLogin = async (a: FastifyInstance, password: string) =>
      (
        await a.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password },
        })
      ).statusCode;

    let a = await boot('first-password');
    expect(await tryLogin(a, 'first-password')).toBe(200);
    await a.close();
    a = await boot('second-password');
    expect(await tryLogin(a, 'first-password')).toBe(401);
    expect(await tryLogin(a, 'second-password')).toBe(200);
    await a.close();
  });
});
