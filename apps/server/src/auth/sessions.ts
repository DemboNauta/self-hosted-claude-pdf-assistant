import crypto from 'node:crypto';
import { and, eq, isNull, lt, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { authSessions, users } from '../db/schema.js';
import { sha256 } from '../services/secrets.js';

export const SESSION_COOKIE = 'pdfclaudeassistant_session';
/** Sliding expiry: every authenticated request pushes the session this far forward. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Avoid a DB write on every request: only refresh when the session is this stale. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Who a valid session belongs to. */
export interface SessionUser {
  id: string;
  role: 'admin' | 'user';
}

export class SessionStore {
  constructor(private readonly db: Db) {}

  create(userId: string, userAgent: string | undefined, now = new Date()): string {
    const token = crypto.randomBytes(32).toString('base64url');
    this.db
      .insert(authSessions)
      .values({
        userId,
        tokenHash: sha256(token),
        lastSeenAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
        userAgent: userAgent?.slice(0, 512) ?? null,
      })
      .run();
    return token;
  }

  /**
   * The account of a live session (extending its expiry), or null. Sessions of
   * disabled accounts are not valid.
   */
  validate(token: string, now = new Date()): SessionUser | null {
    const row = this.db
      .select({ session: authSessions, role: users.role })
      .from(authSessions)
      .innerJoin(users, and(eq(users.id, authSessions.userId), isNull(users.disabledAt)))
      .where(eq(authSessions.tokenHash, sha256(token)))
      .get();
    if (!row) return null;
    const { session } = row;
    if (new Date(session.expiresAt) <= now) {
      this.db.delete(authSessions).where(eq(authSessions.id, session.id)).run();
      return null;
    }
    if (now.getTime() - new Date(session.lastSeenAt).getTime() > TOUCH_INTERVAL_MS) {
      this.db
        .update(authSessions)
        .set({
          lastSeenAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
        })
        .where(eq(authSessions.id, session.id))
        .run();
    }
    return { id: session.userId, role: row.role };
  }

  revoke(token: string): void {
    this.db
      .delete(authSessions)
      .where(eq(authSessions.tokenHash, sha256(token)))
      .run();
  }

  /** Logs an account out everywhere, optionally keeping the current session. */
  revokeAllFor(userId: string, keepToken?: string): void {
    this.db
      .delete(authSessions)
      .where(
        keepToken
          ? and(eq(authSessions.userId, userId), ne(authSessions.tokenHash, sha256(keepToken)))
          : eq(authSessions.userId, userId),
      )
      .run();
  }

  purgeExpired(now = new Date()): void {
    this.db.delete(authSessions).where(lt(authSessions.expiresAt, now.toISOString())).run();
  }
}
