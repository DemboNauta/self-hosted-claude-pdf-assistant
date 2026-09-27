import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import {
  BOARD_WIDTH,
  type BoardColor,
  type BoardStep,
  type ResolvedBoardElement,
} from '@pdfclaudeassistant/shared';

/**
 * Whiteboard geometry on the server: text measured with Excalifont (the font the
 * browser draws with), boxes grown to fit their text, a rough preview image of what
 * Claude drew and warnings about overlaps, so Claude can see and fix its drawing
 * before explaining it.
 */

// Runs from src/claude/ in dev and bundled in dist/ in production.
const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_FILE = [
  path.resolve(here, '../../assets/fonts/Excalifont-Latin.woff2'),
  path.resolve(here, '../assets/fonts/Excalifont-Latin.woff2'),
].find((p) => fs.existsSync(p));

let fontReady: boolean | null = null;
function font() {
  if (fontReady === null) {
    fontReady = !!FONT_FILE && !!GlobalFonts.registerFromPath(FONT_FILE, 'Excalifont');
  }
  // Symbols missing from the Latin subset (→, ², …) come from a system font, as in the browser.
  return fontReady ? 'Excalifont, sans-serif' : 'sans-serif';
}

export const FONT_SIZE = { s: 16, m: 20, l: 28, xl: 36 } as const;
/** Label size inside boxes and on arrows (as the browser draws them, see web convert.ts). */
export const LABEL_SIZE = 20;
export const BODY_SIZE = 16;
export const ARROW_LABEL_SIZE = 16;
const LINE_HEIGHT = 1.25;
/** Excalidraw's padding between a box and its text. */
const PAD = 5;

const STROKE: Record<BoardColor, string> = {
  black: '#1e1e1e',
  blue: '#1971c2',
  red: '#e03131',
  green: '#2f9e44',
  orange: '#f08c00',
  purple: '#9c36b5',
  gray: '#868e96',
};

const measureCtx = createCanvas(4, 4).getContext('2d');
function measure(text: string, size: number) {
  measureCtx.font = `${size}px ${font()}`;
  return measureCtx.measureText(text).width;
}

/** Word wrap as Excalidraw does it (long words are cut). */
export function wrap(text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next, size) <= maxWidth || !line) {
        line = next;
        // A single word wider than the box is cut into pieces.
        while (measure(line, size) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && measure(line.slice(0, cut), size) > maxWidth) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placed {
  el: ResolvedBoardElement;
  /** Measured box (text) or the box grown to fit its text (containers). */
  box: Box | null;
  /** Text lines as drawn, and their size. */
  lines?: string[];
  size?: number;
}

type Container = Extract<ResolvedBoardElement, { type: 'rect' | 'ellipse' | 'diamond' }>;

/** Text inside a box: the label as a title, then the body. */
export function containerText(e: Container): { text: string; size: number } | null {
  if (e.text && e.label) return { text: `${e.label}\n${e.text}`, size: BODY_SIZE };
  if (e.text) return { text: e.text, size: BODY_SIZE };
  if (e.label) return { text: e.label, size: LABEL_SIZE };
  return null;
}

/** Width available to the text of a box (Excalidraw's rules per shape). */
function textWidth(e: Container) {
  if (e.type === 'ellipse') return Math.round((e.w / 2) * Math.SQRT2) - PAD * 2;
  if (e.type === 'diamond') return Math.round(e.w / 2) - PAD * 2;
  return e.w - PAD * 2;
}

/** Height a box needs for its text. */
function neededHeight(e: Container, textH: number) {
  if (e.type === 'ellipse') return Math.round(((textH + PAD * 2) / Math.SQRT2) * 2);
  if (e.type === 'diamond') return Math.round((textH + PAD * 2) * 2);
  return textH + PAD * 2;
}

/**
 * Real geometry of Claude's elements: text measured, boxes grown to fit their text,
 * arrows between the boxes they connect.
 */
export function place(elements: ResolvedBoardElement[]): Placed[] {
  const out: Placed[] = elements.map((el): Placed => {
    switch (el.type) {
      case 'text': {
        const size = FONT_SIZE[el.size ?? 'm'];
        const lines = el.text.split('\n');
        const w = Math.max(...lines.map((l) => measure(l, size)));
        return {
          el,
          box: { x: el.x, y: el.y, w, h: lines.length * size * LINE_HEIGHT },
          lines,
          size,
        };
      }
      case 'rect':
      case 'ellipse':
      case 'diamond': {
        const t = containerText(el);
        if (!t) return { el, box: { x: el.x, y: el.y, w: el.w, h: el.h } };
        const lines = wrap(t.text, t.size, Math.max(10, textWidth(el)));
        const h = Math.max(el.h, neededHeight(el, lines.length * t.size * LINE_HEIGHT));
        return { el, box: { x: el.x, y: el.y, w: el.w, h }, lines, size: t.size };
      }
      case 'pdf':
        return { el, box: { x: el.x, y: el.y, w: el.w, h: el.h } };
      case 'freehand':
      case 'arrow':
      case 'line': {
        const pts = el.points ?? [];
        if (!pts.length) return { el, box: null };
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        return { el, box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } };
      }
    }
  });
  // Arrows connecting boxes: from edge to edge.
  const byId = new Map(
    out
      .filter((p) => 'id' in p.el && p.el.id && p.box)
      .map((p) => [(p.el as { id: string }).id, p]),
  );
  for (const p of out) {
    if ((p.el.type === 'arrow' || p.el.type === 'line') && p.el.from && p.el.to) {
      const a = byId.get(p.el.from)?.box;
      const b = byId.get(p.el.to)?.box;
      if (a && b) {
        const s = edge(a, b);
        const t = edge(b, a);
        p.box = {
          x: Math.min(s.x, t.x),
          y: Math.min(s.y, t.y),
          w: Math.abs(t.x - s.x),
          h: Math.abs(t.y - s.y),
        };
      }
    }
  }
  return out;
}

function edge(a: Box, b: Box) {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (!dx && !dy) return ca;
  const t = Math.min(
    dx ? a.w / 2 / Math.abs(dx) : Infinity,
    dy ? a.h / 2 / Math.abs(dy) : Infinity,
  );
  return { x: ca.x + dx * Math.min(t, 1), y: ca.y + dy * Math.min(t, 1) };
}

/**
 * What is on the board after `steps`: from the last clear, later elements replacing
 * earlier ones with the same id, removed ids dropped.
 */
export function boardElements(steps: BoardStep[]): {
  elements: ResolvedBoardElement[];
  files: Record<string, string>;
  mermaid: number;
} {
  const start = Math.max(0, steps.map((s) => !!s.clear).lastIndexOf(true));
  let elements: ResolvedBoardElement[] = [];
  const files: Record<string, string> = {};
  let mermaid = 0;
  for (const step of steps.slice(start)) {
    if (step.clear) elements = [];
    const gone = new Set([
      ...(step.remove ?? []),
      ...step.elements.map((e) => ('id' in e ? e.id : undefined)).filter(Boolean),
    ]);
    elements = elements.filter((e) => !('id' in e && e.id && gone.has(e.id)));
    elements.push(...step.elements);
    Object.assign(files, step.files ?? {});
    if (step.mermaid) mermaid++;
  }
  return { elements, files, mermaid };
}

const describe = (p: Placed) => {
  const id = 'id' in p.el && p.el.id ? `"${p.el.id}"` : null;
  const text =
    p.el.type === 'text'
      ? p.el.text
      : 'label' in p.el
        ? (p.el.label ?? ('text' in p.el ? p.el.text : undefined))
        : undefined;
  const snippet = text ? `«${text.replace(/\s+/g, ' ').slice(0, 30)}»` : null;
  return [p.el.type, id, snippet].filter(Boolean).join(' ');
};

const area = (b: Box) => b.w * b.h;
function intersection(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const inside = (a: Box, b: Box) =>
  a.x >= b.x - 2 && a.y >= b.y - 2 && a.x + a.w <= b.x + b.w + 2 && a.y + a.h <= b.y + b.h + 2;

/** Problems a teacher would see at a glance: text over text, text over a box's title, off the board. */
export function findProblems(placed: Placed[]): string[] {
  const solid = placed.filter(
    (p) => p.box && (p.el.type === 'text' || p.el.type === 'pdf' || 'w' in p.el),
  ) as (Placed & { box: Box })[];
  const out: string[] = [];
  for (let i = 0; i < solid.length; i++) {
    const a = solid[i]!;
    if (a.box.x + a.box.w > BOARD_WIDTH + 5) {
      out.push(
        `${describe(a)} goes past the right edge (x ${Math.round(a.box.x + a.box.w)} > ${BOARD_WIDTH}).`,
      );
    }
    for (let j = i + 1; j < solid.length; j++) {
      const b = solid[j]!;
      const common = intersection(a.box, b.box);
      if (!common) continue;
      const aText = a.el.type === 'text';
      const bText = b.el.type === 'text';
      const container = (p: Placed) =>
        p.el.type === 'rect' || p.el.type === 'ellipse' || p.el.type === 'diamond';
      // Text placed inside a box that has its own text: they are drawn on top of each other.
      const textIn = (t: typeof a, c: typeof a) =>
        t.el.type === 'text' &&
        container(c) &&
        !!c.lines?.length &&
        // Starts inside the box (it may run out of it).
        t.box.x >= c.box.x &&
        t.box.x <= c.box.x + c.box.w &&
        t.box.y >= c.box.y &&
        t.box.y <= c.box.y + c.box.h;
      if (textIn(a, b) || textIn(b, a)) {
        const [t, c] = textIn(a, b) ? [a, b] : [b, a];
        out.push(
          `${describe(t)} sits inside ${describe(c)}, which already has text: put it in that box's "text" instead.`,
        );
        continue;
      }
      // A free text inside an empty box is fine (a frame), and so are nested boxes.
      if (inside(a.box, b.box) || inside(b.box, a.box)) {
        if (aText && bText) out.push(`${describe(a)} and ${describe(b)} overlap.`);
        continue;
      }
      if (common > 0.04 * Math.min(area(a.box), area(b.box))) {
        out.push(`${describe(a)} and ${describe(b)} overlap.`);
      }
    }
    if (out.length >= 12) break;
  }
  return out.slice(0, 12);
}

/** Longest side of the preview Claude gets. */
const PREVIEW_MAX = 1100;

/**
 * Rough picture of Claude's drawing (straight lines, the real font), so it can check
 * the layout before explaining. The student's own strokes are not in it.
 */
export async function renderPreview(
  placed: Placed[],
  files: Record<string, string>,
  mermaid: number,
): Promise<{ png: Buffer; bounds: Box }> {
  const boxes = placed.map((p) => p.box).filter((b): b is Box => b !== null);
  const minX = Math.min(0, ...boxes.map((b) => b.x)) - 20;
  const minY = Math.min(0, ...boxes.map((b) => b.y)) - 20;
  const maxX = Math.max(BOARD_WIDTH, ...boxes.map((b) => b.x + b.w)) + 20;
  const bottom = Math.max(200, ...boxes.map((b) => b.y + b.h)) + 20 + (mermaid ? 80 : 0);
  const bw = maxX - minX;
  const bh = bottom - minY;
  const scale = Math.min(1, PREVIEW_MAX / Math.max(bw, bh));
  const canvas = createCanvas(Math.ceil(bw * scale), Math.ceil(bh * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(-minX, -minY);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.textBaseline = 'top';

  // The board's right edge, so Claude sees where it ends.
  ctx.save();
  ctx.strokeStyle = '#d0d0d0';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(BOARD_WIDTH, minY);
  ctx.lineTo(BOARD_WIDTH, bottom);
  ctx.stroke();
  ctx.restore();

  const color = (p: Placed) => STROKE[('color' in p.el && p.el.color) || 'black'];
  const drawLines = (
    lines: string[],
    size: number,
    x: number,
    y: number,
    center: boolean,
    w = 0,
  ) => {
    ctx.font = `${size}px ${font()}`;
    lines.forEach((line, i) => {
      const lx = center ? x + (w - measure(line, size)) / 2 : x;
      ctx.fillText(line, lx, y + i * size * LINE_HEIGHT);
    });
  };
  const arrowHead = (fx: number, fy: number, tx: number, ty: number) => {
    const a = Math.atan2(ty - fy, tx - fx);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 12 * Math.cos(a - 0.4), ty - 12 * Math.sin(a - 0.4));
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 12 * Math.cos(a + 0.4), ty - 12 * Math.sin(a + 0.4));
    ctx.stroke();
  };
  const byId = new Map(
    placed
      .filter((p) => 'id' in p.el && p.el.id && p.box)
      .map((p) => [(p.el as { id: string }).id, p.box!]),
  );

  for (const p of placed) {
    const c = color(p);
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    const e = p.el;
    if (e.type === 'rect' || e.type === 'ellipse' || e.type === 'diamond') {
      const b = p.box!;
      ctx.beginPath();
      if (e.type === 'rect') ctx.rect(b.x, b.y, b.w, b.h);
      else if (e.type === 'ellipse')
        ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      else {
        ctx.moveTo(b.x + b.w / 2, b.y);
        ctx.lineTo(b.x + b.w, b.y + b.h / 2);
        ctx.lineTo(b.x + b.w / 2, b.y + b.h);
        ctx.lineTo(b.x, b.y + b.h / 2);
        ctx.closePath();
      }
      ctx.stroke();
      if (p.lines && p.size) {
        const th = p.lines.length * p.size * LINE_HEIGHT;
        const body = !!e.text;
        const tx = b.x + PAD + (e.type === 'rect' ? 0 : (b.w - textWidth(e) - PAD * 2) / 2);
        const ty = body ? b.y + PAD : b.y + (b.h - th) / 2;
        drawLines(p.lines, p.size, tx, ty, !body, textWidth(e));
      }
    } else if (e.type === 'text') {
      drawLines(p.lines!, p.size!, e.x, e.y, false);
    } else if (e.type === 'pdf') {
      const b = p.box!;
      const src = files[e.fileId];
      try {
        if (!src) throw new Error('no file');
        const img = await loadImage(
          Buffer.from(src.replace(/^data:image\/png;base64,/, ''), 'base64'),
        );
        ctx.drawImage(img, b.x, b.y, b.w, b.h);
      } catch {
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
    } else if (e.type === 'arrow' || e.type === 'line') {
      if (e.dashed) ctx.setLineDash([8, 6]);
      let pts: [number, number][] | null = null;
      const a = e.from ? byId.get(e.from) : undefined;
      const b = e.to ? byId.get(e.to) : undefined;
      if (a && b) {
        const s = edge(a, b);
        const t = edge(b, a);
        pts = [
          [s.x, s.y],
          [t.x, t.y],
        ];
      } else if (e.points) pts = e.points;
      if (pts) {
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        ctx.setLineDash([]);
        if (e.type === 'arrow' && pts.length >= 2) {
          const [fx, fy] = pts[pts.length - 2]!;
          const [tx, ty] = pts[pts.length - 1]!;
          arrowHead(fx, fy, tx, ty);
        }
        if (e.label) {
          const mid = pts[Math.floor((pts.length - 1) / 2)]!;
          const next = pts[Math.min(pts.length - 1, Math.floor((pts.length - 1) / 2) + 1)]!;
          const lx = (mid[0] + next[0]) / 2;
          const ly = (mid[1] + next[1]) / 2;
          const w = measure(e.label, ARROW_LABEL_SIZE);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(
            lx - w / 2 - 2,
            ly - ARROW_LABEL_SIZE / 2 - 2,
            w + 4,
            ARROW_LABEL_SIZE * 1.25 + 4,
          );
          ctx.fillStyle = c;
          drawLines([e.label], ARROW_LABEL_SIZE, lx - w / 2, ly - ARROW_LABEL_SIZE / 2, false);
        }
      }
      ctx.setLineDash([]);
    } else if (e.type === 'freehand') {
      ctx.beginPath();
      e.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
  }
  if (mermaid) {
    const y = bottom - 90;
    ctx.fillStyle = '#868e96';
    drawLines(
      [`(+ ${mermaid} Mermaid diagram${mermaid > 1 ? 's' : ''} drawn below by the browser)`],
      16,
      20,
      y,
      false,
    );
  }
  return {
    png: await canvas.encode('png'),
    bounds: { x: minX, y: minY, w: bw, h: bh },
  };
}
