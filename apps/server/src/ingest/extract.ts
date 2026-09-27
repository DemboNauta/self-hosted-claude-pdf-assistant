import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, Util, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { OutlineEntry, Stroke } from '@pdfclaudeassistant/shared';
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

type Region = { x: number; y: number; w: number; h: number };
type Canvas2D = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

/** Grid spacing (page fraction) that gives roughly 5–10 lines across `span`. */
export function gridStep(span: number): number {
  for (const step of [0.01, 0.02, 0.05, 0.1]) if (span / step <= 10) return step;
  return 0.1;
}

/**
 * Draws labelled grid lines in page fractions over a render of `region` (`pw`×`ph` are
 * the pixel size of the whole page at this scale), so Claude can read coordinates for
 * `point_at` rect anchors off the image.
 */
function drawGrid(ctx: Canvas2D, region: Region, pw: number, ph: number) {
  const font = Math.max(14, Math.round(Math.max(pw * region.w, ph * region.h) / 80));
  ctx.font = `${font}px sans-serif`;
  ctx.lineWidth = 1;
  const label = (text: string, x: number, y: number) => {
    const m = ctx.measureText(text);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x - 1, y - 1, m.width + 4, font + 4);
    ctx.fillStyle = '#c2185b';
    ctx.fillText(text, x + 1, y + font);
  };
  // Each axis gets its own spacing, so a wide, short region still has several rows.
  const lines = (from: number, span: number, draw: (v: number, text: string) => void) => {
    const step = gridStep(span);
    const digits = step < 0.1 ? 2 : 1;
    for (let i = Math.ceil(from / step - 1e-9); i * step <= from + span + 1e-9; i++) {
      draw(i * step, (i * step).toFixed(digits));
    }
  };
  ctx.strokeStyle = 'rgba(194,24,91,0.35)';
  lines(region.x, region.w, (v, text) => {
    const px = Math.round((v - region.x) * pw) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, region.h * ph);
    ctx.stroke();
    label(`x${text}`, px + 2, 2);
  });
  lines(region.y, region.h, (v, text) => {
    const py = Math.round((v - region.y) * ph) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(region.w * pw, py);
    ctx.stroke();
    label(`y${text}`, 2, py + 2);
  });
}

/**
 * Renders one page as PNG for Claude (`get_page_image`: figures, formulas, diagrams).
 * `region` (normalised page space) zooms into part of the page (up to 4×); `grid`
 * overlays coordinates in page fractions. The long side is capped so the image stays
 * within what the model reads well.
 */
export async function renderPageImage(
  filePath: string,
  pageNumber: number,
  opts: { region?: Region; grid?: boolean; maxSide?: number } = {},
) {
  const region = opts.region ?? { x: 0, y: 0, w: 1, h: 1 };
  const maxSide = opts.maxSide ?? 1400;
  const pdf = await openPdf(filePath);
  try {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const rw = Math.max(1, region.w * base.width);
    const rh = Math.max(1, region.h * base.height);
    const scale = Math.min(4, maxSide / Math.max(rw, rh));
    const pw = base.width * scale;
    const ph = base.height * scale;
    const viewport = page.getViewport({
      scale,
      offsetX: -region.x * pw,
      offsetY: -region.y * ph,
    });
    const canvas = createCanvas(Math.ceil(rw * scale), Math.ceil(rh * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise;
    if (opts.grid) drawGrid(ctx, region, pw, ph);
    return { png: await canvas.encode('png'), width: canvas.width, height: canvas.height };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/**
 * Renders the part of a page the student marked (`rect`, normalised page space) with
 * their freehand strokes drawn on top, as PNG for Claude. Small areas are zoomed in (up
 * to 4×) so text and formulas stay legible.
 */
export async function renderMarkImage(
  filePath: string,
  pageNumber: number,
  rect: { x: number; y: number; w: number; h: number },
  strokes: Stroke[],
  maxSide = 1200,
) {
  const pdf = await openPdf(filePath);
  try {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const rw = Math.max(1, rect.w * base.width);
    const rh = Math.max(1, rect.h * base.height);
    const scale = Math.min(4, maxSide / Math.max(rw, rh));
    const pw = base.width * scale;
    const ph = base.height * scale;
    const ox = rect.x * pw;
    const oy = rect.y * ph;
    const viewport = page.getViewport({ scale, offsetX: -ox, offsetY: -oy });
    const canvas = createCanvas(Math.ceil(rw * scale), Math.ceil(rh * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.85;
    for (const s of strokes) {
      ctx.strokeStyle = /^#[0-9a-f]{3,8}$/i.test(s.color) ? s.color : '#d1242f';
      ctx.lineWidth = Math.max(2, s.width * pw);
      ctx.beginPath();
      s.points.forEach(([x, y], i) =>
        i === 0 ? ctx.moveTo(x * pw - ox, y * ph - oy) : ctx.lineTo(x * pw - ox, y * ph - oy),
      );
      if (s.points.length === 1)
        ctx.lineTo(s.points[0]![0] * pw - ox + 0.1, s.points[0]![1] * ph - oy);
      ctx.stroke();
    }
    return { png: await canvas.encode('png'), width: canvas.width, height: canvas.height };
  } finally {
    await pdf.loadingTask.destroy();
  }
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
