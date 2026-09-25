import fs from 'node:fs';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { buildAgentEnv } from '../auth-guard.js';
import type { AppConfig } from '../config.js';

/**
 * Baseline options for every Claude Code subprocess (SPEC §6.4 sandbox):
 * no built-in tools (no Bash/Read/Write/Edit/WebFetch), no filesystem settings,
 * no ambient MCP config, an empty isolated cwd, and a filtered environment.
 * Callers add their in-process MCP server and its explicit `allowedTools`.
 */
export function baseAgentOptions(config: AppConfig): Options {
  fs.mkdirSync(config.agentCwd, { recursive: true });
  return {
    cwd: config.agentCwd,
    env: buildAgentEnv(),
    tools: [],
    allowedTools: [],
    permissionMode: 'dontAsk',
    settingSources: [],
    strictMcpConfig: true,
    ...(config.claudeModel ? { model: config.claudeModel } : {}),
  };
}
