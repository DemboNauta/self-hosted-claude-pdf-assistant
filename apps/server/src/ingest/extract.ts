import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, Util, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { OutlineEntry } from '@pdfclaudeassistant/shared';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
// PDF.js requires a trailing "/" (not "\"), and forward slashes also work as fs paths on Windows.
const asDirUrl = (dir: string) => `${path.join(pdfjsRoot, dir).replaceAll('\\', '/')}/`;

/** Compact text item: [text, x, y, width, height], coordinates normalised 0–1, top-left origin. */
export type TextLayerItem = [string, number, number, number, number];

export type { OutlineEntry };

export interface ExtractedPage {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  items: TextLayerItem[];
}

export interface ExtractResult {
  pageCount: number;
  outline: OutlineEntry[];
  pagesWithoutText: number;
}

const COVER_WIDTH = 360;
const round = (n: number) => Math.round(n * 10_000) / 10_000;

export async function openPdf(filePath: string): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(await fs.promises.readFile(filePath));
  return getDocument({
    data,
    standardFontDataUrl: asDirUrl('standard_fonts'),
    cMapUrl: asDirUrl('cmaps'),
    cMapPacked: true,
    wasmUrl: asDirUrl('wasm'),
    verbosity: 0,
  }).promise;
}

/**
 * Extracts per-page text with normalised coordinates (F-ING-04), the outline and a
 * cover thumbnail. Pages are delivered in batches through `onPages` to bound memory.
 */
export async function extractPdf(
  filePath: string,
  coverPath: string,
  onPages: (pages: ExtractedPage[]) => void,
  batchSize = 25,
): Promise<ExtractResult> {
  const pdf = await openPdf(filePath);
  try {
    let batch: ExtractedPage[] = [];
    let pagesWithoutText = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: TextLayerItem[] = [];
      let text = '';
      for (const raw of content.items) {
        if (!('str' in raw)) continue;
        const item = raw as TextItem;
        if (item.str) {
          const tx = Util.transform(viewport.transform, item.transform);
          const fontHeight = Math.hypot(tx[2]!, tx[3]!);
          items.push([
            item.str,
            round(tx[4]! / viewport.width),
            round((tx[5]! - fontHeight) / viewport.height),
            round((item.width * viewport.scale) / viewport.width),
            round(fontHeight / viewport.height),
          ]);
        }
        text += item.str + (item.hasEOL ? '\n' : item.str && !item.str.endsWith(' ') ? ' ' : '');
      }
      text = text.replace(/[ \t]+\n/g, '\n').trim();
      if (!text) pagesWithoutText++;
      batch.push({ pageNumber: n, width: viewport.width, height: viewport.height, text, items });
      page.cleanup();
      if (batch.length >= batchSize) {
        onPages(batch);
        batch = [];
      }
    }
    if (batch.length) onPages(batch);

    await renderCover(pdf, coverPath);
    return { pageCount: pdf.numPages, outline: await readOutline(pdf), pagesWithoutText };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function renderCover(pdf: PDFDocumentProxy, coverPath: string) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: COVER_WIDTH / base.width });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise;
  await fs.promises.mkdir(path.dirname(coverPath), { recursive: true });
  await fs.promises.writeFile(coverPath, await canvas.encode('webp', 80));
}

async function readOutline(pdf: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const outline = await pdf.getOutline().catch(() => null);
  if (!outline) return [];
  const resolve = async (dest: unknown): Promise<number | null> => {
    try {
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit[0] == null) return null;
      const ref = explicit[0] as unknown;
      const index = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref as never);
      return index + 1;
    } catch {
      return null;
    }
  };
  type Node = { title: string; dest: unknown; items: Node[] };
  const walk = async (nodes: Node[]): Promise<OutlineEntry[]> =>
    Promise.all(
      nodes.map(async (n) => ({
        title: n.title,
        page: await resolve(n.dest),
        items: await walk(n.items),
      })),
    );
  return walk(outline as Node[]);
}
