import { hash } from '@node-rs/argon2';
import type { AppConfig } from '../src/config.js';

export const TEST_PASSWORD = 'correct horse battery staple';

export async function testConfig(overrides: Partial<AppConfig> = {}): Promise<AppConfig> {
  return {
    env: 'test',
    host: '127.0.0.1',
    port: 0,
    dataDir: '/tmp/pdfclaudeassistant-test',
    dbPath: ':memory:',
    pdfDir: '/tmp/pdfclaudeassistant-test/pdfs',
    coverDir: '/tmp/pdfclaudeassistant-test/covers',
    agentCwd: '/tmp/pdfclaudeassistant-test/agent-cwd',
    passwordHash: await hash(TEST_PASSWORD),
    sessionSecret: 'x'.repeat(32),
    cookieSecure: false,
    maxUploadBytes: null,
    ocrLangs: 'spa+eng',
    claudeModel: null,
    hasOauthToken: true,
    ...overrides,
  };
}

/** Builds an app with a fake Claude and returns it with a logged-in cookie header. */
export async function authedApp(
  overrides: Partial<AppConfig> = {},
  deps: Partial<import('../src/app.js').AppDeps> = {},
) {
  const { buildApp } = await import('../src/app.js');
  const { ClaudeStatusService } = await import('../src/claude/status.js');
  const config = await testConfig(overrides);
  const claudeStatus = new ClaudeStatusService(config, (() => {
    throw new Error('Claude must not be called');
  }) as never);
  const app = await buildApp(config, { logger: false, claudeStatus, ...deps });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: TEST_PASSWORD },
  });
  const cookie = res.cookies.find((c) => c.name === 'pdfclaudeassistant_session')!;
  return { app, config, headers: { cookie: `${cookie.name}=${cookie.value}` } };
}
