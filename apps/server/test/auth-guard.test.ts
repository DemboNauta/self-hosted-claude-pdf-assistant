import { describe, expect, it } from 'vitest';
import { assertNoApiKey, buildAgentEnv, ForbiddenApiKeyError } from '../src/auth-guard.js';

describe('assertNoApiKey', () => {
  it('passes with a subscription-only environment', () => {
    expect(() => assertNoApiKey({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' })).not.toThrow();
  });

  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])(
    'refuses to start when %s is set',
    (name) => {
      expect(() => assertNoApiKey({ [name]: 'sk-whatever' })).toThrow(ForbiddenApiKeyError);
      expect(() => assertNoApiKey({ [name]: 'sk-whatever' })).toThrow(
        /solo funciona con suscripción/,
      );
    },
  );

  it('refuses even an empty value', () => {
    expect(() => assertNoApiKey({ ANTHROPIC_API_KEY: '' })).toThrow(ForbiddenApiKeyError);
  });
});

describe('buildAgentEnv', () => {
  it('strips credentials and app secrets but keeps the OAuth token and PATH', () => {
    const env = buildAgentEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk',
      ANTHROPIC_AUTH_TOKEN: 'x',
      ANTHROPIC_BASE_URL: 'http://evil',
      SESSION_SECRET: 's',
      APP_PASSWORD_HASH: 'h',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    });
    expect(env).toMatchObject({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    for (const k of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'SESSION_SECRET',
      'APP_PASSWORD_HASH',
    ]) {
      expect(env).not.toHaveProperty(k);
    }
  });
});
