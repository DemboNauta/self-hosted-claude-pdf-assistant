import type { BoardColor, BoardStep, ResolvedBoardElement } from '@pdfclaudeassistant/shared';

/**
 * Claude's board vocabulary → Excalidraw element skeletons (the input of Excalidraw's
 * `convertToExcalidrawElements`). Pure, so it can be tested without Excalidraw.
 */

export const STROKE: Record<BoardColor, string> = {
  black: '#1e1e1e',
  blue: '#1971c2',
  red: '#e03131',
  green: '#2f9e44',
  orange: '#f08c00',
  purple: '#9c36b5',
  gray: '#868e96',
};

export const FILL: Record<BoardColor, string> = {
  black: '#e9ecef',
  blue: '#a5d8ff',
  red: '#ffc9c9',
  green: '#b2f2bb',
  orange: '#ffec99',
  purple: '#eebefa',
  gray: '#e9ecef',
};

const FONT_SIZE = { s: 16, m: 20, l: 28, xl: 36 } as const;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Scene id of an element Claude named: stable, so later steps can connect or replace it. */
export const sceneId = (id: string) => `claude-${id}`;

/** Skeleton as consumed by `convertToExcalidrawElements` (typed loosely on purpose). */
export type Skeleton = Record<string, unknown> & { type: string; x: number; y: number };

/** Where the segment from the centre of `a` towards the centre of `b` leaves `a`. */
function edge(a: Box, b: Box) {
  const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (!dx && !dy) return ca;
  const t = Math.min(
    dx ? a.width / 2 / Math.abs(dx) : Infinity,
    dy ? a.height / 2 / Math.abs(dy) : Infinity,
  );
  return { x: ca.x + dx * Math.min(t, 1), y: ca.y + dy * Math.min(t, 1) };
}

function boxOf(e: ResolvedBoardElement): Box | null {
  if (e.type === 'rect' || e.type === 'ellipse' || e.type === 'diamond' || e.type === 'pdf') {
    return { x: e.x, y: e.y, width: e.w, height: e.h };
  }
  if (e.type === 'text') {
    const px = FONT_SIZE[e.size ?? 'm'];
    const lines = e.text.split('\n');
    return {
      x: e.x,
      y: e.y,
      width: Math.max(...lines.map((l) => l.length)) * px * 0.55,
      height: lines.length * px * 1.25,
    };
  }
  return null;
}

const relative = (points: [number, number][]) => {
  const [x0, y0] = points[0]!;
  return { x: x0, y: y0, points: points.map(([x, y]) => [x - x0, y - y0]) };
};

/**
 * Skeletons for one step. `existing` gives the boxes of elements already on the board
 * (by scene id), so arrows can connect to things drawn in earlier steps.
 */
export function stepSkeletons(step: BoardStep, existing: Map<string, Box>): Skeleton[] {
  const boxes = new Map(existing);
  const here = new Set<string>();
  for (const e of step.elements) {
    const id = 'id' in e && e.id ? sceneId(e.id) : null;
    const box = boxOf(e);
    if (id && box) {
      boxes.set(id, box);
      here.add(id);
    }
  }

  const out: Skeleton[] = [];
  for (const e of step.elements) {
    const stroke = STROKE[('color' in e && e.color) || 'black'];
    const id = 'id' in e && e.id ? { id: sceneId(e.id) } : {};
    switch (e.type) {
      case 'text':
        out.push({
          type: 'text',
          ...id,
          x: e.x,
          y: e.y,
          text: e.text,
          fontSize: FONT_SIZE[e.size ?? 'm'],
          strokeColor: stroke,
        });
        break;
      case 'rect':
      case 'ellipse':
      case 'diamond':
        out.push({
          type: e.type === 'rect' ? 'rectangle' : e.type,
          ...id,
          x: e.x,
          y: e.y,
          width: e.w,
          height: e.h,
          strokeColor: stroke,
          ...(e.fill && {
            backgroundColor: FILL[e.color ?? 'black'],
            fillStyle: 'hachure',
          }),
          // A heading alone is centred; with a body, both go top left and the box grows.
          ...(e.text
            ? {
                label: {
                  text: e.label ? `${e.label}\n${e.text}` : e.text,
                  fontSize: 16,
                  strokeColor: stroke,
                  textAlign: 'left',
                  verticalAlign: 'top',
                },
              }
            : e.label && { label: { text: e.label, fontSize: 20, strokeColor: stroke } }),
        });
        break;
      case 'pdf':
        out.push({
          type: 'image',
          ...id,
          x: e.x,
          y: e.y,
          width: e.w,
          height: e.h,
          fileId: e.fileId,
          status: 'saved',
        });
        break;
      case 'freehand':
        out.push({
          type: 'line',
          ...relative(e.points),
          strokeColor: stroke,
          roundness: { type: 2 },
        });
        break;
      case 'arrow':
      case 'line': {
        const common = {
          type: e.type,
          ...id,
          strokeColor: stroke,
          ...(e.dashed && { strokeStyle: 'dashed' }),
          ...(e.label && { label: { text: e.label, fontSize: 16, strokeColor: stroke } }),
          ...(e.type === 'line' && { endArrowhead: null }),
        };
        const from = e.from ? sceneId(e.from) : null;
        const to = e.to ? sceneId(e.to) : null;
        if (from && to && here.has(from) && here.has(to) && e.type === 'arrow') {
          // Both ends drawn in this step: Excalidraw binds the arrow to them.
          const a = boxes.get(from)!;
          const b = boxes.get(to)!;
          const s = edge(a, b);
          const t = edge(b, a);
          out.push({
            ...common,
            ...relative([
              [s.x, s.y],
              [t.x, t.y],
            ]),
            start: { id: from },
            end: { id: to },
          });
        } else if (from && to && boxes.has(from) && boxes.has(to)) {
          const a = boxes.get(from)!;
          const b = boxes.get(to)!;
          const s = edge(a, b);
          const t = edge(b, a);
          out.push({
            ...common,
            ...relative([
              [s.x, s.y],
              [t.x, t.y],
            ]),
          });
        } else if (e.points) {
          out.push({ ...common, ...relative(e.points) });
        }
        break;
      }
    }
  }
  return out;
}

/** Lowest point of a set of element boxes (0 for none). */
export function bottomOf(boxes: Iterable<Box>): number {
  let bottom = 0;
  for (const b of boxes) bottom = Math.max(bottom, b.y + b.height);
  return bottom;
}
