import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openPdf, type TextLayerItem } from './extract.js';

/** Rectangle in normalised page space (0–1, origin top-left). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutLabel {
  id: string;
  text: string;
  box: Box;
}

export type LayoutBlock =
  | { id: string; kind: 'heading' | 'text'; box: Box; text: string; lines: number }
  | {
      id: string;
      kind: 'figure';
      /** Raster image, vector drawing (diagrams, charts, tables) or both. */
      source: 'image' | 'drawing' | 'mixed';
      box: Box;
      /** Text inside the figure (axis labels, node names…), each with its own box. */
      labels: LayoutLabel[];
    };

export interface PageLayout {
  page: number;
  blocks: LayoutBlock[];
  /** No text layer and one image covering most of the page: a scan. */
  scanned: boolean;
}

/** Graphics painted on a page: raster images and vector drawings (path bounds). */
export interface PageGraphics {
  images: Box[];
  drawings: Box[];
}

type Matrix = number[];

const IMAGE_OPS = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintImageMaskXObject,
  OPS.paintImageXObjectRepeat,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageMaskXObjectGroup,
]);

/**
 * Finds where images and vector paths are painted on a page by walking its operator list
 * and tracking the current transform. Coordinates are normalised like the text items.
 */
export async function pageGraphics(filePath: string, pageNumber: number): Promise<PageGraphics> {
  const pdf = await openPdf(filePath);
  try {
    const page = await pdf.getPage(pageNumber);
    const vp = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const images: Box[] = [];
    const drawings: Box[] = [];
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    const box = (x0: number, y0: number, x1: number, y1: number): Box | null => {
      const m = Util.transform(vp.transform, ctm);
      const pts = [x0, y0, x1, y0, x0, y1, x1, y1];
      for (let i = 0; i < 8; i += 2) Util.applyTransform(pts, m, i);
      const xs = [pts[0]!, pts[2]!, pts[4]!, pts[6]!].map((v) => v / vp.width);
      const ys = [pts[1]!, pts[3]!, pts[5]!, pts[7]!].map((v) => v / vp.height);
      const bx = Math.max(0, Math.min(...xs));
      const by = Math.max(0, Math.min(...ys));
      const bw = Math.min(1, Math.max(...xs)) - bx;
      const bh = Math.min(1, Math.max(...ys)) - by;
      if (![bx, by, bw, bh].every(Number.isFinite) || bw < 0 || bh < 0) return null;
      return { x: bx, y: by, w: bw, h: bh };
    };
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i]!;
      const args = ops.argsArray[i] as unknown[] | null;
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = Util.transform(ctm, args as Matrix);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        const matrix = args?.[0] as Matrix | null | undefined;
        if (Array.isArray(matrix) && matrix.length === 6) ctm = Util.transform(ctm, matrix);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (IMAGE_OPS.has(fn)) {
        const b = box(0, 0, 1, 1);
        if (b) images.push(b);
      } else if (fn === OPS.constructPath) {
        const mm = args?.[2] as ArrayLike<number> | null | undefined;
        if (mm && mm.length >= 4) {
          const b = box(mm[0]!, mm[1]!, mm[2]!, mm[3]!);
          if (b) drawings.push(b);
        }
      }
    }
    page.cleanup();
    return { images, drawings };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const right = (b: Box) => b.x + b.w;
const bottom = (b: Box) => b.y + b.h;

export function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    w: Math.max(...boxes.map(right)) - x,
    h: Math.max(...boxes.map(bottom)) - y,
  };
}

function near(a: Box, b: Box, gap: number) {
  return (
    a.x - gap <= right(b) &&
    b.x - gap <= right(a) &&
    a.y - gap <= bottom(b) &&
    b.y - gap <= bottom(a)
  );
}

/** Merges boxes that touch or lie within `gap` of each other, until nothing changes. */
export function cluster(boxes: Box[], gap: number): { box: Box; members: number[] }[] {
  let groups = boxes.map((b, i) => ({ box: b, members: [i] }));
  for (let changed = true; changed;) {
    changed = false;
    const next: typeof groups = [];
    for (const g of groups) {
      const hit = next.find((n) => near(n.box, g.box, gap));
      if (hit) {
        hit.box = union([hit.box, g.box]);
        hit.members.push(...g.members);
        changed = true;
      } else next.push({ ...g, members: [...g.members] });
    }
    groups = next;
  }
  return groups;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const roundBox = (b: Box): Box => ({ x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) });

interface Line {
  items: TextLayerItem[];
  box: Box;
  /** Font height (the tallest item). */
  size: number;
}

const itemBox = ([, x, y, w, h]: TextLayerItem): Box => ({ x, y, w, h });

function lineText(line: Line) {
  let out = '';
  for (const [str] of [...line.items].sort((a, b) => a[1] - b[1])) {
    out += out && !out.endsWith(' ') && !str.startsWith(' ') ? ` ${str}` : str;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Groups text items into lines: same baseline band, and close enough horizontally. */
function toLines(items: TextLayerItem[]): Line[] {
  const lines: Line[] = [];
  const sorted = [...items].filter((i) => i[0].trim()).sort((a, b) => a[2] - b[2] || a[1] - b[1]);
  for (const item of sorted) {
    const b = itemBox(item);
    const cy = b.y + b.h / 2;
    const line = lines.find((l) => {
      const lcy = l.box.y + l.box.h / 2;
      const size = Math.max(l.size, b.h);
      return (
        Math.abs(lcy - cy) < size * 0.5 &&
        b.x < right(l.box) + size * 2.5 &&
        right(b) > l.box.x - size * 2.5
      );
    });
    if (line) {
      line.items.push(item);
      line.box = union([line.box, b]);
      line.size = Math.max(line.size, b.h);
    } else lines.push({ items: [item], box: b, size: b.h });
  }
  return lines;
}

const overlapX = (a: Box, b: Box) => Math.min(right(a), right(b)) - Math.max(a.x, b.x);

/** Groups lines into paragraphs/headings: close vertically, overlapping and same size. */
function toBlocks(lines: Line[]): Line[][] {
  const blocks: Line[][] = [];
  for (const line of [...lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    const block = blocks.find((bl) => {
      const last = bl[bl.length - 1]!;
      const gap = line.box.y - bottom(last.box);
      const ratio = Math.max(line.size, last.size) / Math.max(1e-6, Math.min(line.size, last.size));
      return (
        gap > -line.size * 0.3 &&
        gap < Math.max(line.size, last.size) * 0.9 &&
        overlapX(line.box, union(bl.map((l) => l.box))) > 0 &&
        ratio < 1.25
      );
    });
    if (block) block.push(line);
    else blocks.push([line]);
  }
  return blocks;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

const inside = (b: Box, outer: Box, pad: number) => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return (
    cx >= outer.x - pad &&
    cx <= right(outer) + pad &&
    cy >= outer.y - pad &&
    cy <= bottom(outer) + pad
  );
};

/**
 * Structure of a page for pointing precisely: text blocks (headings, paragraphs) and
 * figures (images and vector drawings, with the text labels inside them), each with a
 * short id and its box. Pure: the text items come from ingestion, graphics from
 * `pageGraphics`.
 */
export function buildLayout(
  page: number,
  items: TextLayerItem[],
  graphics: PageGraphics,
): PageLayout {
  // Page-sized rectangles are backgrounds or frames, thin isolated strokes are rules.
  const big = (b: Box) => b.w > 0.9 && b.h > 0.85;
  const images = graphics.images.filter((b) => b.w > 0.01 && b.h > 0.01);
  const drawings = graphics.drawings.filter((b) => !big(b));
  const all = [
    ...images.map((b) => ({ b, image: true })),
    ...drawings.map((b) => ({ b, image: false })),
  ];
  const scanned = !items.some((i) => i[0].trim()) && images.some((b) => b.w * b.h > 0.6);

  const figures = cluster(
    all.map((a) => a.b),
    0.012,
  )
    .filter(({ box, members }) => {
      const hasImage = members.some((m) => all[m]!.image);
      if (hasImage) return box.w * box.h > 0.002;
      // Lone rules and underlines are decoration, not figures.
      return box.w > 0.03 && box.h > 0.03 && members.length > 1;
    })
    .map(({ box, members }) => {
      const img = members.filter((m) => all[m]!.image).length;
      const source: 'image' | 'drawing' | 'mixed' =
        img === members.length ? 'image' : img === 0 ? 'drawing' : 'mixed';
      return { box, source };
    });

  const inFigure = new Map<number, TextLayerItem[]>();
  const loose: TextLayerItem[] = [];
  for (const item of items) {
    if (!item[0].trim()) continue;
    const f = scanned ? -1 : figures.findIndex((fig) => inside(itemBox(item), fig.box, 0.005));
    if (f >= 0) inFigure.set(f, [...(inFigure.get(f) ?? []), item]);
    else loose.push(item);
  }

  const blocks = toBlocks(toLines(loose));
  const bodySize = median(blocks.flatMap((bl) => bl.flatMap((l) => l.items.map(() => l.size))));
  type Pending = { box: Box; make: (id: string) => LayoutBlock; figure: boolean };
  const pending: Pending[] = [];
  for (const bl of blocks) {
    const box = union(bl.map((l) => l.box));
    const text = bl.map(lineText).join(' ');
    const size = median(bl.map((l) => l.size));
    const heading = bl.length <= 2 && text.length < 160 && bodySize > 0 && size > bodySize * 1.2;
    pending.push({
      box,
      figure: false,
      make: (id) => ({
        id,
        kind: heading ? 'heading' : 'text',
        box: roundBox(box),
        text,
        lines: bl.length,
      }),
    });
  }
  figures.forEach((fig, f) => {
    const labelLines = toLines(inFigure.get(f) ?? []).sort(
      (a, b) => a.box.y - b.box.y || a.box.x - b.box.x,
    );
    pending.push({
      box: fig.box,
      figure: true,
      make: (id) => ({
        id,
        kind: 'figure',
        source: fig.source,
        box: roundBox(fig.box),
        labels: labelLines.slice(0, 40).map((l, i) => ({
          id: `${id}.${i + 1}`,
          text: lineText(l),
          box: roundBox(l.box),
        })),
      }),
    });
  });

  // Reading order: top to bottom, then left to right for blocks side by side.
  pending.sort((a, b) =>
    Math.abs(a.box.y - b.box.y) < 0.01 ? a.box.x - b.box.x : a.box.y - b.box.y,
  );
  let t = 0;
  let f = 0;
  return {
    page,
    scanned,
    blocks: pending.map((p) => p.make(p.figure ? `f${++f}` : `b${++t}`)),
  };
}

/** The box of a block, figure or figure label by id (e.g. "b3", "f1", "f1.2"). */
export function findLayoutBox(layout: PageLayout, id: string): Box | null {
  for (const b of layout.blocks) {
    if (b.id === id) return b.box;
    if (b.kind === 'figure') {
      const label = b.labels.find((l) => l.id === id);
      if (label) return label.box;
    }
  }
  return null;
}

const fmt = (b: Box) => `[x ${b.x}, y ${b.y}, w ${b.w}, h ${b.h}]`;

function preview(text: string, max = 110) {
  if (text.length <= max) return `"${text}"`;
  const words = text.split(/\s+/).length;
  return `"${text.slice(0, max).replace(/\s+\S*$/, '')}…" (${words} words)`;
}

/** Layout as text for Claude. */
export function formatLayout(layout: PageLayout): string {
  const head = `Page ${layout.page} layout. Boxes are page fractions (origin top-left). Use the ids as point_at anchors: {"kind":"block","id":"b2"}.`;
  if (layout.scanned) {
    return `${head}\nThis page is a scanned image without a text layer: use get_page_image with "grid" to find positions.`;
  }
  if (!layout.blocks.length) return `${head}\n(empty page)`;
  const lines = layout.blocks.map((b) => {
    if (b.kind !== 'figure') return `${b.id} ${b.kind} ${fmt(b.box)} ${preview(b.text)}`;
    const what =
      b.source === 'image'
        ? 'image'
        : b.source === 'drawing'
          ? 'vector drawing'
          : 'image + drawing';
    const labels = b.labels.length
      ? `\n${b.labels.map((l) => `  ${l.id} label ${fmt(l.box)} ${preview(l.text, 60)}`).join('\n')}`
      : ' (no text inside: look at it with get_page_image using this box as "region")';
    return `${b.id} figure (${what}) ${fmt(b.box)}${labels}`;
  });
  return `${head}\n${lines.join('\n')}`;
}
