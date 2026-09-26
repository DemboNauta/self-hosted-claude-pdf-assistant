/**
 * Writes a dated backup (SQLite snapshot + PDFs + covers) into DATA_DIR/backups.
 * On the VPS: docker compose exec server node dist/backup.js  (e.g. from cron).
 */
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/client.js';
import { writeBackupFile } from '../src/services/backup.js';

const config = loadConfig();
const db = openDb(config.dbPath);
try {
  console.log(await writeBackupFile(db, config));
} finally {
  db.$client.close();
}
