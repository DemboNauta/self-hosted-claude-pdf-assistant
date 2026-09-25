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
