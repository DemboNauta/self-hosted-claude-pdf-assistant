import path from 'node:path';
import { z } from 'zod';

const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().default('./data'),
  APP_PASSWORD_HASH: z.string().startsWith('$argon2', 'APP_PASSWORD_HASH must be an argon2 hash'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  COOKIE_SECURE: booleanish.optional(),
  /** 0 means unlimited (resolved open decision 6). */
  MAX_UPLOAD_MB: z.coerce.number().min(0).default(0),
  OCR_LANGS: z.string().default('spa+eng'),
  CLAUDE_MODEL: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
});

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  agentCwd: string;
  passwordHash: string;
  sessionSecret: string;
  cookieSecure: boolean;
  maxUploadBytes: number | null;
  ocrLangs: string;
  claudeModel: string | null;
  hasOauthToken: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  }
  const e = parsed.data;
  const dataDir = path.resolve(e.DATA_DIR);
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    dataDir,
    dbPath: path.join(dataDir, 'pdfclaudeassistant.db'),
    agentCwd: path.join(dataDir, 'agent-cwd'),
    passwordHash: e.APP_PASSWORD_HASH,
    sessionSecret: e.SESSION_SECRET,
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    maxUploadBytes: e.MAX_UPLOAD_MB > 0 ? Math.floor(e.MAX_UPLOAD_MB * 1024 * 1024) : null,
    ocrLangs: e.OCR_LANGS,
    claudeModel: e.CLAUDE_MODEL?.trim() || null,
    hasOauthToken: Boolean(e.CLAUDE_CODE_OAUTH_TOKEN?.trim()),
  };
}
