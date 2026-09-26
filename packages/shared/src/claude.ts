/**
 * How Claude Code authenticated against the user's subscription.
 * `other` = the probe succeeded with credentials the app did not recognise
 * (e.g. managed by the host environment).
 */
export type ClaudeAuthMethod = 'oauth_token' | 'interactive_login' | 'other' | 'none';

/**
 * Connection state shown in Settings → "Conexión con Claude".
 * - connected: a minimal query succeeded using the subscription.
 * - auth_expired: no credentials, or they were rejected.
 * - rate_limited: the subscription hit its usage limit.
 * - error: anything else (CLI missing, network, ...).
 * - not_configured: the user has not saved a Claude token yet (multi-user).
 */
export type ClaudeConnectionState =
  'connected' | 'auth_expired' | 'rate_limited' | 'error' | 'not_configured';

export interface ClaudeStatus {
  state: ClaudeConnectionState;
  authMethod: ClaudeAuthMethod;
  model: string | null;
  checkedAt: string;
  message?: string;
}
