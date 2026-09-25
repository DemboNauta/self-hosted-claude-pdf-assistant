import type { Anchor, PointerGroup, PointerShape } from '@pdfclaudeassistant/shared';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useChat } from '../chat/store';
import type { PageLayers } from './PdfPage';
import { findQuoteRects, type NormRect } from './textMatch';

/** Claude's own colour (resolved decision #2: orange, distinct from the user's palette). */
const CLAUDE = '#e8590c';

/** Rectangles covered by an anchor, in normalised page space. */
export function resolveAnchor(anchor: Anchor, layers: PageLayers): NormRect[] {
  if (anchor.kind === 'rect') return [{ x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h }];
  if (!layers.textLayer || !layers.pageEl) return [];
  const all = findQuoteRects(layers.textLayer, layers.pageEl, anchor.quote, { all: true });
  return all[Math.min((anchor.occurrence ?? 1) - 1, all.length - 1)] ?? [];
}

export function unionRect(rects: NormRect[]): NormRect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

interface Resolved {
  shape: PointerShape;
  rects: NormRect[];
  box: NormRect;
}

/** One mark, in CSS pixels of the page (`w`×`h`). */
function Mark({ r, w, h, delay }: { r: Resolved; w: number; h: number; delay: number }) {
  const pad = 6;
  const bx = r.box.x * w - pad;
  const by = r.box.y * h - pad;
  const bw = r.box.w * w + pad * 2;
  const bh = r.box.h * h + pad * 2;
  const style = { animationDelay: `${delay}ms` };
  const labelY = by > 28 ? by - 8 : by + bh + 18;

  let shape: React.ReactNode = null;
  switch (r.shape.type) {
    case 'highlight':
      shape = r.rects.map((q, i) => (
        <rect
          key={i}
          x={q.x * w - 1}
          y={q.y * h - 1}
          width={q.w * w + 2}
          height={q.h * h + 2}
          rx={2}
          fill={CLAUDE}
          fillOpacity={0.28}
          className="pointer-fade"
          style={style}
        />
      ));
      break;
    case 'rect':
      shape = (
        <rect
          x={bx}
          y={by}
          width={bw}
          height={bh}
          rx={6}
          pathLength={1}
          className="pointer-draw"
          style={style}
        />
      );
      break;
    case 'circle':
      shape = (
        <ellipse
          cx={bx + bw / 2}
          cy={by + bh / 2}
          rx={(bw / 2) * 1.12 + 4}
          ry={(bh / 2) * 1.25 + 4}
          pathLength={1}
          className="pointer-draw"
          style={style}
        />
      );
      break;
    case 'arrow': {
      // Comes in from the left margin, or from above when the target is near the edge.
      const tx = bx - 2;
      const ty = by + bh / 2;
      const fromLeft = tx > 70;
      const sx = fromLeft ? Math.max(8, tx - 90) : bx + bw / 2 - 40;
      const sy = fromLeft ? ty - 36 : Math.max(8, by - 70);
      const ex = fromLeft ? tx : bx + bw / 2;
      const ey = fromLeft ? ty : by - 2;
      const angle = Math.atan2(ey - sy, ex - sx);
      const head = 10;
      const p1 = `${ex - head * Math.cos(angle - 0.45)},${ey - head * Math.sin(angle - 0.45)}`;
      const p2 = `${ex - head * Math.cos(angle + 0.45)},${ey - head * Math.sin(angle + 0.45)}`;
      shape = (
        <g>
          <path
            d={`M${sx},${sy} Q${(sx + ex) / 2},${sy} ${ex},${ey}`}
            pathLength={1}
            className="pointer-draw"
            style={style}
          />
          <polygon
            points={`${ex},${ey} ${p1} ${p2}`}
            fill={CLAUDE}
            className="pointer-fade"
            style={style}
          />
        </g>
      );
      break;
    }
    case 'label':
      break;
  }

  return (
    <g>
      {shape}
      {r.shape.label && (
        <foreignObject
          x={Math.min(Math.max(4, bx), w - 224)}
          y={labelY - 22}
          width={220}
          height={60}
          className="pointer-fade overflow-visible"
          style={style}
        >
          <span
            className="inline-block max-w-[220px] rounded-md px-2 py-1 text-xs leading-snug font-medium text-white shadow"
            style={{ background: CLAUDE }}
          >
            {r.shape.label}
          </span>
        </foreignObject>
      )}
    </g>
  );
}

/** Claude's temporary marks on one page (F-POINT-01/02). */
export function PointerLayer({
  pageNumber,
  docId,
  layers,
  width,
  height,
}: {
  pageNumber: number;
  docId: string;
  layers: PageLayers;
  width: number;
  height: number;
}) {
  const groups = useChat(
    useShallow((s) => s.pointers.filter((g) => g.page === pageNumber && g.docId === docId)),
  );
  const resolved = useMemo(() => {
    const out: { group: PointerGroup; marks: Resolved[] }[] = [];
    for (const group of groups) {
      const marks: Resolved[] = [];
      for (const shape of group.shapes) {
        const rects = resolveAnchor(shape.anchor, layers);
        const box = unionRect(rects);
        if (box) marks.push({ shape, rects, box });
      }
      out.push({ group, marks });
    }
    return out;
  }, [groups, layers]);

  const marks = resolved.flatMap(({ group, marks }) => marks.map((m) => ({ group, m })));
  if (!marks.length) return null;
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-visible"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      stroke={CLAUDE}
      strokeWidth={2.5}
      strokeLinecap="round"
      data-testid="claude-pointers"
    >
      {marks.map(({ group, m }, i) => (
        <Mark key={`${group.messageId}-${i}`} r={m} w={width} h={height} delay={i * 180} />
      ))}
    </svg>
  );
}
