import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** Login sessions for the single user; only a SHA-256 of the cookie token is stored. */
export const authSessions = sqliteTable('auth_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  lastSeenAt: text('last_seen_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  userAgent: text('user_agent'),
});
