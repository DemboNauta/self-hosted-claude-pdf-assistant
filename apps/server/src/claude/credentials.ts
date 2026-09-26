import fs from 'node:fs';
import { OWNER_ID, type UserService } from '../services/users.js';

/**
 * Which Claude subscription a request runs on (multi-user):
 * - `server`: the credentials configured on the server (CLAUDE_CODE_OAUTH_TOKEN or an
 *   interactive login), which belong to the admin and only the admin may use;
 * - `token`: the user's own `claude setup-token` token. Users other than the admin get
 *   their own Claude Code config dir, so they never see the admin's login or sessions.
 */
export type ClaudeAuth =
  { kind: 'server' } | { kind: 'token'; token: string; configDir: string | null };

export class ClaudeCredentials {
  constructor(private readonly users: UserService) {}

  /** Null when the user has no way to reach Claude yet (no token saved). */
  forUser(userId: string): ClaudeAuth | null {
    const token = this.users.claudeToken(userId);
    if (userId === OWNER_ID)
      return token ? { kind: 'token', token, configDir: null } : { kind: 'server' };
    if (!token) return null;
    const configDir = this.users.claudeConfigDir(userId);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    return { kind: 'token', token, configDir };
  }
}
