import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { CreateUpload, DocumentSummary, UploadSession } from '@pdfclaudeassistant/shared';
import type { AppConfig } from '../config.js';
import { HttpError, notFound } from './errors.js';
import { newId } from './ids.js';
import type { LibraryService } from './library.js';

/** 32 MiB: well under Cloudflare's 100 MB request limit, small enough to retry cheaply. */
export const CHUNK_SIZE = 32 * 1024 * 1024;
/** Unfinished uploads untouched for this long are deleted. */
const STALE_MS = 24 * 60 * 60 * 1000;
const PDF_MAGIC = Buffer.from('%PDF-');

interface UploadMeta {
  id: string;
  topicId: string;
  filename: string;
  size: number;
}

/** Title from a file name: drop extension, turn separators into spaces. */
export function titleFromFilename(name: string): string {
  const base = path
    .basename(name)
    .replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .trim();
  return (base || 'Documento sin título').slice(0, 200);
}

/**
 * Resumable chunked uploads (F-ING-01). Each upload is a `<id>.json` metadata file
 * plus a `<id>.part` file that chunks are appended to; the byte count on disk is the
 * source of truth, so an upload survives server restarts and client retries.
 */
export class UploadService {
  private readonly dir: string;
  private readonly busy = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly library: LibraryService,
    private readonly onCreated: (docId: string) => void,
  ) {
    this.dir = path.join(config.dataDir, 'uploads');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(config.pdfDir, { recursive: true });
  }

  create(input: CreateUpload): UploadSession {
    const max = this.config.maxUploadBytes;
    if (max !== null && input.size > max) throw new HttpError(413, 'file_too_large');
    this.library.getTopicOrThrow(input.topicId);
    const meta: UploadMeta = { id: newId(), ...input };
    fs.writeFileSync(this.partPath(meta.id), '');
    fs.writeFileSync(this.metaPath(meta.id), JSON.stringify(meta));
    return { id: meta.id, size: meta.size, received: 0, chunkSize: CHUNK_SIZE };
  }

  status(id: string): UploadSession {
    const meta = this.meta(id);
    return { id, size: meta.size, received: this.received(id), chunkSize: CHUNK_SIZE };
  }

  /**
   * Appends a chunk that must start at `offset` (= bytes already stored). On any
   * failure the part file is truncated back, so a retry of the same chunk is safe.
   */
  async appendChunk(id: string, offset: number, body: Readable): Promise<UploadSession> {
    const meta = this.meta(id);
    if (this.busy.has(id)) throw new HttpError(409, 'upload_busy');
    const received = this.received(id);
    if (offset !== received) throw new OffsetMismatch(received);

    this.busy.add(id);
    const limit = Math.min(CHUNK_SIZE, meta.size - received);
    let written = 0;
    const out = fs.createWriteStream(this.partPath(id), { flags: 'a' });
    try {
      for await (const buf of body as AsyncIterable<Buffer>) {
        written += buf.length;
        if (written > limit) throw new HttpError(413, 'chunk_too_large');
        if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
    } catch (err) {
      out.destroy();
      await fs.promises.truncate(this.partPath(id), received).catch(() => {});
      throw err;
    } finally {
      this.busy.delete(id);
    }

    // Reject non-PDFs as soon as the first bytes arrive instead of after the whole file.
    if (offset === 0 && !(await startsWithPdfMagic(this.partPath(id)))) {
      await this.cancel(id);
      throw new HttpError(415, 'not_a_pdf');
    }
    return this.status(id);
  }

  /** Turns a fully received upload into a document and hands it to ingestion. */
  async complete(id: string): Promise<DocumentSummary> {
    const meta = this.meta(id);
    if (this.busy.has(id)) throw new HttpError(409, 'upload_busy');
    if (this.received(id) !== meta.size) throw new HttpError(409, 'upload_incomplete');
    if (!(await startsWithPdfMagic(this.partPath(id)))) {
      await this.cancel(id);
      throw new HttpError(415, 'not_a_pdf');
    }
    try {
      // The topic may have been deleted while the file was uploading.
      this.library.getTopicOrThrow(meta.topicId);
    } catch (err) {
      await this.cancel(id);
      throw err;
    }
    const finalPath = path.join(this.config.pdfDir, `${id}.pdf`);
    await fs.promises.rename(this.partPath(id), finalPath);
    await fs.promises.rm(this.metaPath(id), { force: true });
    const doc = this.library.createDocument({
      id,
      topicId: meta.topicId,
      title: titleFromFilename(meta.filename),
      filePath: finalPath,
      fileSize: meta.size,
    });
    this.onCreated(id);
    return doc;
  }

  async cancel(id: string): Promise<void> {
    this.meta(id);
    await fs.promises.rm(this.partPath(id), { force: true });
    await fs.promises.rm(this.metaPath(id), { force: true });
  }

  /** Deletes uploads abandoned for more than a day. Returns how many were removed. */
  purgeStale(now = Date.now()): number {
    let removed = 0;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const mtime = fs.statSync(
        fs.existsSync(this.partPath(id)) ? this.partPath(id) : this.metaPath(id),
      ).mtimeMs;
      if (now - mtime < STALE_MS || this.busy.has(id)) continue;
      fs.rmSync(this.partPath(id), { force: true });
      fs.rmSync(this.metaPath(id), { force: true });
      removed++;
    }
    return removed;
  }

  private meta(id: string): UploadMeta {
    // Ids come from the URL: only accept our own alphabet so they can't escape the directory.
    if (!/^[0-9a-z]{1,64}$/.test(id)) throw notFound();
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(id), 'utf8')) as UploadMeta;
    } catch {
      throw notFound();
    }
  }

  private received(id: string): number {
    return fs.statSync(this.partPath(id), { throwIfNoEntry: false })?.size ?? 0;
  }

  private metaPath(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  private partPath(id: string) {
    return path.join(this.dir, `${id}.part`);
  }
}

/** The client's offset is out of sync; it should resume from `received`. */
export class OffsetMismatch extends HttpError {
  constructor(readonly received: number) {
    super(409, 'offset_mismatch');
  }
}

async function startsWithPdfMagic(file: string): Promise<boolean> {
  const fh = await fs.promises.open(file, 'r');
  try {
    // Some PDFs have leading junk; the spec allows the header within the first 1024 bytes.
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(PDF_MAGIC);
  } finally {
    await fh.close();
  }
}
