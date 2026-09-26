import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { create } from 'tar';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';

/** What a backup contains: the database snapshot and the user's files (SPEC §11). */
const INCLUDED = ['pdfs', 'covers'];

export const backupFileName = (d = new Date()) =>
  `pdfclaudeassistant-backup-${d.toISOString().slice(0, 10)}.tar.gz`;

/**
 * Streams a dated `.tar.gz` with a consistent SQLite snapshot and the PDFs/covers.
 * Claude's credentials (`claude-home`), upload leftovers and the agent's working dir
 * are never included (SPEC §12).
 */
export async function createBackup(
  db: Db,
  config: AppConfig,
): Promise<{ stream: Readable; cleanup: () => void }> {
  // better-sqlite3's online backup gives a consistent copy while the app keeps writing.
  // The snapshot sits next to the data (no links to the PDFs folder that a cleanup
  // could follow) and is renamed inside the archive.
  const snapshot = `.backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const snapshotPath = path.join(config.dataDir, snapshot);
  await db.$client.backup(snapshotPath);
  const entries = [
    snapshot,
    ...INCLUDED.filter((d) => fs.existsSync(path.join(config.dataDir, d))),
  ];
  const stream = create(
    {
      gzip: true,
      cwd: config.dataDir,
      portable: true,
      onWriteEntry: (entry) => {
        if (entry.path === snapshot) entry.path = 'pdfclaudeassistant.db';
      },
    },
    entries,
  ) as unknown as Readable;
  const cleanup = () => fs.rmSync(snapshotPath, { force: true });
  stream.on('end', cleanup);
  stream.on('error', cleanup);
  stream.on('close', cleanup);
  return { stream, cleanup };
}

/** CLI for cron on the VPS: writes a backup file into DATA_DIR/backups. */
export async function writeBackupFile(db: Db, config: AppConfig): Promise<string> {
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backupFileName());
  const { stream } = await createBackup(db, config);
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file);
    stream.pipe(out);
    out.on('finish', resolve);
    stream.on('error', reject);
    out.on('error', reject);
  });
  return file;
}
