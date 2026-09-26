import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeAuthMethod, ClaudeStatus } from '@pdfclaudeassistant/shared';
import { FORBIDDEN_CLAUDE_ENV_VARS } from '../auth-guard.js';
import type { AppConfig } from '../config.js';
import type { ClaudeAuth } from './credentials.js';
import { classifyAssistantError, classifyErrorText } from './errors.js';
import { baseAgentOptions } from './options.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;

/** Which subscription credential Claude Code will use (SPEC §6.2). */
export function detectAuthMethod(config: AppConfig, auth: ClaudeAuth | null): ClaudeAuthMethod {
  if (!auth) return 'none';
  if (auth.kind === 'token' || config.hasOauthToken) return 'oauth_token';
  const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return fs.existsSync(path.join(home, '.credentials.json')) ? 'interactive_login' : 'none';
}

type QueryFn = typeof query;

/**
 * Health check for each user's Claude connection. Each probe is a real (tiny) request
 * that counts against that user's subscription, so results are cached per user.
 */
export class ClaudeStatusService {
  private readonly cached = new Map<string, ClaudeStatus>();
  private readonly inFlight = new Map<string, Promise<ClaudeStatus>>();

  constructor(
    private readonly config: AppConfig,
    private readonly runQuery: QueryFn = query,
  ) {}

  async get(userId: string, auth: ClaudeAuth | null, refresh = false): Promise<ClaudeStatus> {
    if (!auth) {
      this.cached.delete(userId);
      return {
        state: 'not_configured',
        authMethod: 'none',
        model: null,
        checkedAt: new Date().toISOString(),
      };
    }
    const cached = this.cached.get(userId);
    const fresh = cached && Date.now() - new Date(cached.checkedAt).getTime() < CACHE_TTL_MS;
    if (fresh && !refresh) return cached;
    let probe = this.inFlight.get(userId);
    if (!probe) {
      probe = this.probe(auth).finally(() => this.inFlight.delete(userId));
      this.inFlight.set(userId, probe);
    }
    const status = await probe;
    this.cached.set(userId, status);
    return status;
  }

  /** Lets the chat report auth/limit failures without an extra probe. */
  report(
    userId: string,
    auth: ClaudeAuth,
    status: Omit<ClaudeStatus, 'checkedAt' | 'authMethod'>,
  ): void {
    this.cached.set(userId, {
      ...status,
      authMethod: detectAuthMethod(this.config, auth),
      checkedAt: new Date().toISOString(),
    });
  }

  /** Forgets a user's cached state (their token changed). */
  forget(userId: string): void {
    this.cached.delete(userId);
  }

  private async probe(auth: ClaudeAuth): Promise<ClaudeStatus> {
    const authMethod = detectAuthMethod(this.config, auth);
    const base = { authMethod, checkedAt: new Date().toISOString() };
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), PROBE_TIMEOUT_MS);
    let model: string | null = this.config.claudeModel;

    try {
      const q = this.runQuery({
        prompt: 'Reply with the single word: ok',
        options: {
          ...baseAgentOptions(this.config, auth),
          abortController,
          maxTurns: 1,
          persistSession: false,
        },
      });
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          model = msg.model;
          if ((FORBIDDEN_CLAUDE_ENV_VARS as readonly string[]).includes(msg.apiKeySource)) {
            return {
              ...base,
              model,
              state: 'error',
              message: 'Claude Code is using an API key, not the subscription.',
            };
          }
        } else if (msg.type === 'rate_limit_event' && msg.rate_limit_info.status === 'rejected') {
          return {
            ...base,
            model,
            state: 'rate_limited',
            message: resetMessage(msg.rate_limit_info.resetsAt),
          };
        } else if (msg.type === 'assistant' && msg.error) {
          const state = classifyAssistantError(msg.error) ?? 'error';
          return { ...base, model, state, message: msg.error };
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success' && !msg.is_error) {
            return {
              ...base,
              authMethod: authMethod === 'none' ? 'other' : authMethod,
              model,
              state: 'connected',
            };
          }
          const text = msg.subtype === 'success' ? msg.result : msg.errors.join('; ');
          return { ...base, model, state: classifyErrorText(text), message: text };
        }
      }
      return { ...base, model, state: 'error', message: 'No result from Claude Code.' };
    } catch (err) {
      const text = abortController.signal.aborted
        ? 'Timed out'
        : err instanceof Error
          ? err.message
          : String(err);
      return { ...base, model, state: classifyErrorText(text), message: text };
    } finally {
      clearTimeout(timer);
    }
  }
}

function resetMessage(resetsAt: number | undefined): string {
  if (!resetsAt) return 'Usage limit reached.';
  return `Usage limit reached until ${new Date(resetsAt * 1000).toISOString()}.`;
}
