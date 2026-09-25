import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeAuthMethod, ClaudeStatus } from '@pdfclaudeassistant/shared';
import { FORBIDDEN_CLAUDE_ENV_VARS } from '../auth-guard.js';
import type { AppConfig } from '../config.js';
import { classifyAssistantError, classifyErrorText } from './errors.js';
import { baseAgentOptions } from './options.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;

/** Which subscription credential Claude Code will use (SPEC §6.2). */
export function detectAuthMethod(config: AppConfig): ClaudeAuthMethod {
  if (config.hasOauthToken) return 'oauth_token';
  const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return fs.existsSync(path.join(home, '.credentials.json')) ? 'interactive_login' : 'none';
}

type QueryFn = typeof query;

/**
 * Health check for the Claude connection. Each probe is a real (tiny) request that
 * counts against the subscription, so results are cached.
 */
export class ClaudeStatusService {
  private cached: ClaudeStatus | null = null;
  private inFlight: Promise<ClaudeStatus> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly runQuery: QueryFn = query,
  ) {}

  async get(refresh = false): Promise<ClaudeStatus> {
    const fresh =
      this.cached && Date.now() - new Date(this.cached.checkedAt).getTime() < CACHE_TTL_MS;
    if (fresh && !refresh) return this.cached!;
    this.inFlight ??= this.probe().finally(() => (this.inFlight = null));
    this.cached = await this.inFlight;
    return this.cached;
  }

  /** Lets the chat report auth/limit failures without an extra probe. */
  report(status: Omit<ClaudeStatus, 'checkedAt' | 'authMethod'>): void {
    this.cached = {
      ...status,
      authMethod: detectAuthMethod(this.config),
      checkedAt: new Date().toISOString(),
    };
  }

  private async probe(): Promise<ClaudeStatus> {
    const authMethod = detectAuthMethod(this.config);
    const base = { authMethod, checkedAt: new Date().toISOString() };
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), PROBE_TIMEOUT_MS);
    let model: string | null = this.config.claudeModel;

    try {
      const q = this.runQuery({
        prompt: 'Reply with the single word: ok',
        options: {
          ...baseAgentOptions(this.config),
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
