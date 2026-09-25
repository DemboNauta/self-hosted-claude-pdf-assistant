import crypto from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { authSessions } from '../db/schema.js';

export const SESSION_COOKIE = 'pdfclaudeassistant_session';
/** Sliding expiry: every authenticated request pushes the session this far forward. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Avoid a DB write on every request: only refresh when the session is this stale. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export class SessionStore {
  constructor(private readonly db: Db) {}

  create(userAgent: string | undefined, now = new Date()): string {
    const token = crypto.randomBytes(32).toString('base64url');
    this.db
      .insert(authSessions)
      .values({
        tokenHash: hashToken(token),
        lastSeenAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
        userAgent: userAgent?.slice(0, 512) ?? null,
      })
      .run();
    return token;
  }

  /** Returns true if the token belongs to a live session, extending its expiry. */
  validate(token: string, now = new Date()): boolean {
    const tokenHash = hashToken(token);
    const row = this.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.tokenHash, tokenHash))
      .get();
    if (!row) return false;
    if (new Date(row.expiresAt) <= now) {
      this.db.delete(authSessions).where(eq(authSessions.id, row.id)).run();
      return false;
    }
    if (now.getTime() - new Date(row.lastSeenAt).getTime() > TOUCH_INTERVAL_MS) {
      this.db
        .update(authSessions)
        .set({
          lastSeenAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
        })
        .where(eq(authSessions.id, row.id))
        .run();
    }
    return true;
  }

  revoke(token: string): void {
    this.db
      .delete(authSessions)
      .where(eq(authSessions.tokenHash, hashToken(token)))
      .run();
  }

  purgeExpired(now = new Date()): void {
    this.db.delete(authSessions).where(lt(authSessions.expiresAt, now.toISOString())).run();
  }
}
