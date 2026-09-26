import fs from 'node:fs';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { buildAgentEnv } from '../auth-guard.js';
import type { AppConfig } from '../config.js';
import type { ClaudeAuth } from './credentials.js';

/**
 * Baseline options for every Claude Code subprocess (SPEC §6.4 sandbox):
 * no built-in tools (no Bash/Read/Write/Edit/WebFetch), no filesystem settings,
 * no ambient MCP config, an empty isolated cwd, and a filtered environment carrying
 * the credentials of the user the request is for. Callers add their in-process MCP
 * server and its explicit `allowedTools`.
 */
export function baseAgentOptions(config: AppConfig, auth: ClaudeAuth): Options {
  fs.mkdirSync(config.agentCwd, { recursive: true });
  return {
    cwd: config.agentCwd,
    env: agentEnv(auth),
    tools: [],
    allowedTools: [],
    permissionMode: 'dontAsk',
    settingSources: [],
    strictMcpConfig: true,
    ...(config.claudeModel ? { model: config.claudeModel } : {}),
  };
}

function agentEnv(auth: ClaudeAuth): Record<string, string> {
  const env = buildAgentEnv();
  if (auth.kind === 'server') return env;
  env.CLAUDE_CODE_OAUTH_TOKEN = auth.token;
  if (auth.configDir) env.CLAUDE_CONFIG_DIR = auth.configDir;
  return env;
}
