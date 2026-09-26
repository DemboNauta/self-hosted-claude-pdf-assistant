import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

// This file runs from src/db/ in dev and is bundled into dist/ in production.
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = [
  path.resolve(here, '../../drizzle'),
  path.resolve(here, '../drizzle'),
].find((p) => fs.existsSync(path.join(p, 'meta')))!;

/** Opens (or creates) the SQLite database and applies pending migrations. */
export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  // Foreign keys stay off while migrating: SQLite refuses to add a REFERENCES column
  // with a default otherwise (0012 gives existing rows to the admin that way). The
  // check afterwards makes sure no migration left a dangling reference.
  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder });
  const dangling = sqlite.pragma('foreign_key_check') as unknown[];
  if (dangling.length) throw new Error(`Migration left ${dangling.length} broken reference(s)`);
  sqlite.pragma('foreign_keys = ON');
  return db;
}
