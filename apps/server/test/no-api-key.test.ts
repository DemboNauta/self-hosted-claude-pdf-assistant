/**
 * SPEC §6.3: fail if an Anthropic API key or a direct Anthropic API endpoint shows
 * up anywhere in our source or configuration. Only the guard that rejects the key
 * (and its tests) may name it; Markdown docs may mention it to warn against it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const KEY_NAME = ['ANTHROPIC', 'API', 'KEY'].join('_');
const API_HOST = ['api', 'anthropic', 'com'].join('.');
const DIRECT_SDK = ['@anthropic-ai', 'sdk'].join('/');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'data',
  'coverage',
  'test-results',
  'playwright-report',
  'drizzle',
]);
const SKIP_FILES = new Set(['pnpm-lock.yaml']);
const KEY_ALLOWED = new Set([
  'apps/server/src/auth-guard.ts',
  'apps/server/test/auth-guard.test.ts',
]);

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (!SKIP_FILES.has(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

const files = [...walk(repoRoot)].map((abs) => ({
  rel: path.relative(repoRoot, abs).split(path.sep).join('/'),
  abs,
}));
const isDoc = (rel: string) => rel.endsWith('.md');

describe('subscription-only guard', () => {
  it('scans a non-trivial file set', () => {
    expect(files.some((f) => f.rel === 'apps/server/src/main.ts')).toBe(true);
  });

  it(`never references ${KEY_NAME} outside the guard`, () => {
    const offenders = files
      .filter((f) => !isDoc(f.rel) && !KEY_ALLOWED.has(f.rel))
      .filter((f) => fs.readFileSync(f.abs, 'utf8').includes(KEY_NAME))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('never calls the Anthropic API directly', () => {
    const offenders = files
      .filter((f) => !isDoc(f.rel))
      .filter((f) => fs.readFileSync(f.abs, 'utf8').includes(API_HOST))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it(`never depends on ${DIRECT_SDK} directly`, () => {
    const offenders = files
      .filter((f) => f.rel.endsWith('package.json'))
      .filter((f) => {
        const pkg = JSON.parse(fs.readFileSync(f.abs, 'utf8')) as Record<
          string,
          Record<string, string> | undefined
        >;
        return [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].some(
          (d) => d && DIRECT_SDK in d,
        );
      })
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('never imports it in source', () => {
    const importRe = new RegExp(`from ['"]${DIRECT_SDK.replace('/', '\\/')}['"/]`);
    const offenders = files
      .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f.rel))
      .filter((f) => importRe.test(fs.readFileSync(f.abs, 'utf8')))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
