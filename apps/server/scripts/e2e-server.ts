/**
 * Server for Playwright e2e tests: fresh temp data dir, fixed password and a fake
 * Claude probe, so CI never needs (or spends) a real subscription session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash } from '@node-rs/argon2';
import { buildApp } from '../src/app.js';
import { assertNoApiKey } from '../src/auth-guard.js';
import { ClaudeStatusService } from '../src/claude/status.js';
import { loadConfig } from '../src/config.js';

assertNoApiKey();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfclaudeassistant-e2e-'));
const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  PORT: process.env.PORT ?? '3100',
  APP_PASSWORD_HASH: await hash(process.env.E2E_PASSWORD ?? 'e2e-password'),
  SESSION_SECRET: 'e2e'.repeat(16),
  CLAUDE_CODE_OAUTH_TOKEN: 'e2e-fake-token',
});

const fakeQuery = (() =>
  (async function* () {
    yield { type: 'system', subtype: 'init', model: 'claude-e2e', apiKeySource: 'oauth' };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
  })()) as never;

const app = await buildApp(config, {
  logger: false,
  loginAttemptsPerMinute: 1000,
  claudeStatus: new ClaudeStatusService(config, fakeQuery),
});
await app.listen({ host: '127.0.0.1', port: config.port });
console.log(`e2e server on :${config.port} (data: ${dataDir})`);
