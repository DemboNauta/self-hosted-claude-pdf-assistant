import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { makePdf } from './fixtures/pdf.js';

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
export async function authedApp(overrides: Partial<AppConfig> = {}, deps: Partial<AppDeps> = {}) {
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

/** Creates subject → topic → PDF (one text line array per page) and waits for ingestion. */
export async function seedDocument(
  app: FastifyInstance,
  headers: Record<string, string>,
  pagesText: string[][],
): Promise<{ docId: string; topicId: string; subjectId: string }> {
  const subjectId = (
    await app.inject({ method: 'POST', url: '/api/subjects', headers, payload: { name: 'S' } })
  ).json<{ id: string }>().id;
  const topicId = (
    await app.inject({
      method: 'POST',
      url: '/api/topics',
      headers,
      payload: { subjectId, name: 'T' },
    })
  ).json<{ id: string }>().id;
  const pdf = await makePdf(pagesText);
  const up = (
    await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers,
      payload: { topicId, filename: 'doc.pdf', size: pdf.length },
    })
  ).json<{ id: string }>();
  await app.inject({
    method: 'PUT',
    url: `/api/uploads/${up.id}?offset=0`,
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload: pdf,
  });
  const docId = (
    await app.inject({ method: 'POST', url: `/api/uploads/${up.id}/complete`, headers })
  ).json<{ id: string }>().id;
  await (app as unknown as { pcaIngest: { idle(): Promise<void> } }).pcaIngest.idle();
  return { docId, topicId, subjectId };
}

/** A temp data dir config override for tests that write files. */
export function tempDataDir(prefix: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dataDir, pdfDir: path.join(dataDir, 'pdfs'), coverDir: path.join(dataDir, 'covers') };
}
