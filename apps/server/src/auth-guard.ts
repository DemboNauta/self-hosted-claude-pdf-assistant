/**
 * PdfClaudeAssistant only works with the owner's Claude subscription (SPEC §6.1).
 * Claude Code prefers an API key over OAuth credentials when one is present in the
 * environment, so any of these variables would silently switch to pay-per-use.
 */
export const FORBIDDEN_CLAUDE_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * Variables stripped from the Claude Code subprocess environment: the forbidden
 * credentials plus anything that would redirect it away from the subscription,
 * and the app's own secrets, which the agent never needs.
 */
const STRIPPED_FROM_AGENT_ENV = [
  ...FORBIDDEN_CLAUDE_ENV_VARS,
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'APP_PASSWORD_HASH',
  'SESSION_SECRET',
];

export class ForbiddenApiKeyError extends Error {
  constructor(readonly variable: string) {
    super(
      `Este proyecto solo funciona con suscripción. Elimina ${variable}. ` +
        `(PdfClaudeAssistant only works with a Claude subscription; remove ${variable} from the environment.)`,
    );
    this.name = 'ForbiddenApiKeyError';
  }
}

/** Throws if any forbidden API credential is defined, even as an empty string. */
export function assertNoApiKey(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of FORBIDDEN_CLAUDE_ENV_VARS) {
    if (env[name] !== undefined) throw new ForbiddenApiKeyError(name);
  }
}

/** Environment passed to the Claude Code subprocess (the SDK replaces, not merges, it). */
export function buildAgentEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || STRIPPED_FROM_AGENT_ENV.includes(key)) continue;
    filtered[key] = value;
  }
  filtered.CLAUDE_AGENT_SDK_CLIENT_APP = 'PdfClaudeAssistant/0.0.0';
  return filtered;
}
