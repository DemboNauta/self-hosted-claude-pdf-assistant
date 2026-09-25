import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../services/errors.js';
import { parse } from './validate.js';

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('pdfjs-dist/package.json'));

const params = z.object({
  dir: z.enum(['cmaps', 'standard_fonts', 'wasm', 'iccs']),
  file: z.string().regex(/^[\w.-]+$/),
});

const TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/vnd.iccprofile',
};

/**
 * PDF.js data files for the browser viewer (CJK cmaps, standard fonts, wasm decoders),
 * served from the same pdfjs-dist the server uses so versions always match.
 */
export async function registerPdfjsAssets(app: FastifyInstance) {
  app.get('/api/pdfjs/:dir/:file', async (req, reply) => {
    const { dir, file } = parse(params, req.params);
    const full = path.join(root, dir, file);
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat?.isFile()) throw notFound();
    return reply
      .header('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
      .header('cache-control', 'private, max-age=604800')
      .send(fs.createReadStream(full));
  });
}
