import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import type { DocumentSummary } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { IngestService } from '../ingest/service.js';
import { HttpError } from '../services/errors.js';
import { newId } from '../services/ids.js';
import type { LibraryService } from '../services/library.js';
import { parse } from './validate.js';

const uploadQuery = z.object({ topicId: z.string().min(1).max(64) });
const PDF_MAGIC = Buffer.from('%PDF-');

/** Title from a file name: drop extension, turn separators into spaces. */
export function titleFromFilename(name: string): string {
  const base = path
    .basename(name)
    .replace(/\.pdf$/i, '')
    .replace(/[_]+/g, ' ')
    .trim();
  return (base || 'Documento sin título').slice(0, 200);
}

/** Multi-file PDF upload into a topic, streamed straight to disk (F-ING-01). */
export async function registerUploadRoutes(
  app: FastifyInstance,
  config: AppConfig,
  library: LibraryService,
  ingest: IngestService,
) {
  await app.register(multipart, {
    limits: {
      // null = unlimited (open decision #6).
      fileSize: config.maxUploadBytes ?? Number.POSITIVE_INFINITY,
      files: 1000,
      fields: 10,
    },
  });
  await fs.promises.mkdir(config.pdfDir, { recursive: true });

  app.post('/api/documents/upload', async (req, reply) => {
    const { topicId } = parse(uploadQuery, req.query);
    library.getTopicOrThrow(topicId);

    const created: DocumentSummary[] = [];
    const rejected: { name: string; reason: string }[] = [];
    for await (const part of req.files()) {
      const id = newId();
      const finalPath = path.join(config.pdfDir, `${id}.pdf`);
      const tmpPath = `${finalPath}.part`;
      try {
        await pipeline(part.file, fs.createWriteStream(tmpPath));
        if (part.file.truncated) throw new HttpError(413, 'file_too_large');
        if (!(await startsWithPdfMagic(tmpPath))) throw new HttpError(415, 'not_a_pdf');
        await fs.promises.rename(tmpPath, finalPath);
        const { size } = await fs.promises.stat(finalPath);
        created.push(
          library.createDocument({
            id,
            topicId,
            title: titleFromFilename(part.filename),
            filePath: finalPath,
            fileSize: size,
          }),
        );
        ingest.enqueue(id);
      } catch (err) {
        await fs.promises.rm(tmpPath, { force: true });
        const reason = err instanceof HttpError ? err.code : 'upload_failed';
        if (!(err instanceof HttpError)) req.log.error(err);
        rejected.push({ name: part.filename, reason });
      }
    }
    if (created.length === 0 && rejected.length === 0) throw new HttpError(400, 'no_files');
    return reply.code(created.length ? 201 : 400).send({ created, rejected });
  });
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
