import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_CLAUDE_ENV_VARS } from '../src/auth-guard.js';
import { ClaudeStatusService } from '../src/claude/status.js';
import { testConfig } from './helpers.js';

const SERVER = { kind: 'server' } as const;

function fakeQuery(messages: Partial<SDKMessage>[]) {
  const calls: unknown[] = [];
  const fn = ((params: unknown) => {
    calls.push(params);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  }) as never;
  return { fn, calls };
}

describe('ClaudeStatusService', () => {
  it('reports connected on a successful probe, with a sandboxed, key-free environment', async () => {
    const { fn, calls } = fakeQuery([
      { type: 'system', subtype: 'init', model: 'claude-x', apiKeySource: 'oauth' } as never,
      { type: 'result', subtype: 'success', is_error: false, result: 'ok' } as never,
    ]);
    const status = await new ClaudeStatusService(await testConfig(), fn).get('u', SERVER);
    expect(status).toMatchObject({
      state: 'connected',
      authMethod: 'oauth_token',
      model: 'claude-x',
    });

    const { options } = calls[0] as {
      options: Record<string, unknown> & { env: Record<string, string> };
    };
    expect(options.tools).toEqual([]);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settingSources).toEqual([]);
    for (const k of FORBIDDEN_CLAUDE_ENV_VARS) expect(options.env).not.toHaveProperty(k);
  });

  it('flags a session that somehow uses an API key', async () => {
    const { fn } = fakeQuery([
      {
        type: 'system',
        subtype: 'init',
        model: 'm',
        apiKeySource: FORBIDDEN_CLAUDE_ENV_VARS[0],
      } as never,
    ]);
    expect((await new ClaudeStatusService(await testConfig(), fn).get('u', SERVER)).state).toBe(
      'error',
    );
  });

  it('maps authentication failures to auth_expired', async () => {
    const { fn } = fakeQuery([{ type: 'assistant', error: 'authentication_failed' } as never]);
    expect((await new ClaudeStatusService(await testConfig(), fn).get('u', SERVER)).state).toBe(
      'auth_expired',
    );
  });

  it('maps rejected rate limits to rate_limited', async () => {
    const { fn } = fakeQuery([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } } as never,
    ]);
    expect((await new ClaudeStatusService(await testConfig(), fn).get('u', SERVER)).state).toBe(
      'rate_limited',
    );
  });

  it('caches results unless refresh is requested', async () => {
    const { fn, calls } = fakeQuery([
      { type: 'result', subtype: 'success', is_error: false, result: 'ok' } as never,
    ]);
    const svc = new ClaudeStatusService(await testConfig(), fn);
    await svc.get('u', SERVER);
    await svc.get('u', SERVER);
    expect(calls).toHaveLength(1);
    await svc.get('u', SERVER, true);
    expect(calls).toHaveLength(2);
  });
});
