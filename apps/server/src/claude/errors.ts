import type { ClaudeConnectionState } from '@pdfclaudeassistant/shared';

/** Maps an SDK assistant error code to the state shown in the UI. */
export function classifyAssistantError(code: string | undefined): ClaudeConnectionState | null {
  switch (code) {
    case undefined:
      return null;
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
    case 'verification_required':
      return 'auth_expired';
    case 'rate_limit':
    case 'billing_error':
      return 'rate_limited';
    default:
      return 'error';
  }
}

/** Best-effort classification of free-form error text from the CLI. */
export function classifyErrorText(text: string): ClaudeConnectionState {
  const t = text.toLowerCase();
  if (/(usage limit|rate limit|rate_limit|limit reached|too many requests|429)/.test(t)) {
    return 'rate_limited';
  }
  if (
    /(not logged in|please run \/login|invalid api key|unauthori[sz]ed|401|oauth|expired|authentication)/.test(
      t,
    )
  ) {
    return 'auth_expired';
  }
  return 'error';
}
