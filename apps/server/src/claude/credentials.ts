import fs from 'node:fs';
import type { AppConfig } from '../config.js';
import { OWNER_ID, type UserService } from '../services/users.js';

/**
 * Which Claude subscription a request runs on (multi-user):
 * - `server`: the credentials configured on the server (CLAUDE_CODE_OAUTH_TOKEN or an
 *   interactive login), which belong to the admin. The admin uses them, and so does any
 *   user the admin gave access to them. `configDir` keeps such a user's Claude Code
 *   sessions apart from the admin's when the server has a token (an interactive login
 *   only exists in the default config dir, so then it stays null);
 * - `token`: the user's own `claude setup-token` token. Users other than the admin get
 *   their own Claude Code config dir, so they never see the admin's login or sessions.
 */
export type ClaudeAuth =
  | { kind: 'server'; configDir: string | null }
  | { kind: 'token'; token: string; configDir: string | null };

export class ClaudeCredentials {
  constructor(
    private readonly users: UserService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Null when the user has no way to reach Claude yet. A personal token always wins
   * over access to the server's credentials.
   */
  forUser(userId: string): ClaudeAuth | null {
    const token = this.users.claudeToken(userId);
    if (userId === OWNER_ID)
      return token
        ? { kind: 'token', token, configDir: null }
        : { kind: 'server', configDir: null };
    if (token) return { kind: 'token', token, configDir: this.configDir(userId) };
    if (!this.users.usesServerClaude(userId)) return null;
    return {
      kind: 'server',
      configDir: this.config.hasOauthToken ? this.configDir(userId) : null,
    };
  }

  private configDir(userId: string) {
    const dir = this.users.claudeConfigDir(userId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
}
