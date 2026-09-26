import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import { documents, pages } from '../db/schema.js';
import type { AppConfig } from '../config.js';
import { coverPath } from '../services/library.js';
import type { ExtractResult } from './extract.js';
import type { OcrRunner } from './ocr.js';
import type { WorkerInput, WorkerMessage } from './worker.js';

/**
 * In the bundle the worker is dist/ingest-worker.js. In dev/tests it is TypeScript:
 * Node would strip its types natively and skip tsx's `.js` -> `.ts` resolution, so a
 * tiny eval'd bootstrap registers tsx first.
 */
function createWorker(workerData: WorkerInput): Worker {
  if (!import.meta.url.endsWith('.ts')) {
    return new Worker(new URL('./ingest-worker.js', import.meta.url), { workerData });
  }
  const entry = JSON.stringify(new URL('./worker.ts', import.meta.url).href);
  const bootstrap = `import('tsx/esm/api').then(({ register }) => { register(); return import(${entry}); });`;
  return new Worker(bootstrap, { eval: true, workerData });
}

/**
 * Background ingestion queue (F-ING-04, F-ING-05). Documents are processed one at a
 * time in a worker thread; the UI polls document status. Survives restarts by
 * re-queueing anything left unfinished.
 */
export class IngestService {
  private queue: string[] = [];
  private running = false;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly log: FastifyBaseLogger,
    /** OCR for pages without text (F-ING-03); null when ocrmypdf is not installed. */
    private readonly ocr: OcrRunner | null = null,
  ) {}

  /** Re-queues documents interrupted by a restart. */
  resume() {
    const pending = this.db
      .select({ id: documents.id })
      .from(documents)
      .where(inArray(documents.status, ['queued', 'ocr', 'indexing']))
      .all();
    for (const { id } of pending) this.enqueue(id);
  }

  enqueue(id: string) {
    if (!this.queue.includes(id)) this.queue.push(id);
    void this.drain();
  }

  /** Resolves when the queue is empty (tests). */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let id = this.queue.shift(); id; id = this.queue.shift()) {
        await this.process(id);
      }
    } finally {
      this.running = false;
      this.idleWaiters.splice(0).forEach((r) => r());
    }
  }

  private async process(id: string) {
    const row = this.db.select().from(documents).where(eq(documents.id, id)).get();
    if (!row || row.deletedAt) return;
    this.setStatus(id, 'indexing');
    // Re-processing starts from a clean slate.
    this.db.delete(pages).where(eq(pages.documentId, id)).run();

    try {
      const input = { filePath: row.filePath, coverPath: coverPath(this.config, id) };
      let result = await this.runWorker(input, id);
      let hasOcr = row.hasOcr;
      if (result.pagesWithoutText > 0 && this.ocr && !row.hasOcr) {
        hasOcr = await this.runOcr(id, row.filePath);
        if (hasOcr) {
          this.db.delete(pages).where(eq(pages.documentId, id)).run();
          result = await this.runWorker(input, id);
        }
      }
      this.db
        .update(documents)
        .set({
          status: 'ready',
          error: null,
          pageCount: result.pageCount,
          hasCover: true,
          hasOcr,
          outlineJson: JSON.stringify(result.outline),
        })
        .where(eq(documents.id, id))
        .run();
      this.log.info(
        { docId: id, pages: result.pageCount, withoutText: result.pagesWithoutText },
        'document ingested',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ docId: id, err: message }, 'document ingestion failed');
      this.db
        .update(documents)
        .set({ status: 'error', error: message.slice(0, 500) })
        .where(eq(documents.id, id))
        .run();
    }
  }

  /**
   * Replaces the served file with an OCR'd copy (text layer added to scanned pages).
   * The original is kept next to it as `<id>.orig.pdf`. Failures leave the document
   * indexed without OCR.
   */
  private async runOcr(id: string, filePath: string): Promise<boolean> {
    this.db.update(documents).set({ status: 'ocr' }).where(eq(documents.id, id)).run();
    const out = `${filePath}.ocr.part`;
    try {
      await this.ocr!(filePath, out);
      await fs.promises.copyFile(filePath, filePath.replace(/\.pdf$/, '.orig.pdf'));
      await fs.promises.rename(out, filePath);
      this.db.update(documents).set({ status: 'indexing' }).where(eq(documents.id, id)).run();
      return true;
    } catch (err) {
      await fs.promises.rm(out, { force: true });
      this.log.warn(
        { docId: id, err: err instanceof Error ? err.message : String(err) },
        'OCR failed',
      );
      this.db.update(documents).set({ status: 'indexing' }).where(eq(documents.id, id)).run();
      return false;
    }
  }

  private runWorker(input: WorkerInput, docId: string): Promise<ExtractResult> {
    return new Promise((resolve, reject) => {
      const worker = createWorker(input);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
        void worker.terminate();
      };
      worker.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'pages') {
          this.db.transaction((tx) => {
            for (const p of msg.pages) {
              tx.insert(pages)
                .values({
                  documentId: docId,
                  pageNumber: p.pageNumber,
                  width: p.width,
                  height: p.height,
                  text: p.text,
                  textLayerJson: JSON.stringify(p.items),
                })
                .run();
            }
          });
        } else if (msg.type === 'done') {
          finish(() => resolve(msg.result));
        } else {
          finish(() => reject(new Error(msg.message)));
        }
      });
      worker.on('error', (err) => finish(() => reject(err)));
      worker.on('exit', (code) =>
        finish(() => reject(new Error(`ingest worker exited with code ${code}`))),
      );
    });
  }

  private setStatus(id: string, status: 'queued' | 'indexing') {
    this.db.update(documents).set({ status }).where(eq(documents.id, id)).run();
  }
}
