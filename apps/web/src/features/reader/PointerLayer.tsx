import type { Anchor, PointerGroup, PointerShape } from '@pdfclaudeassistant/shared';
import { MessageCircleQuestion, X } from 'lucide-react';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { t } from '../../i18n';
import { useChatDock } from '../chat/ChatDock';
import { useChat } from '../chat/store';
import { useVoice } from '../voice/store';
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
  /** Target of a connecting arrow. */
  to?: NormRect;
}

type Pt = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

/** Where the segment from the centre of `b` towards `p` leaves the box. */
function exitPoint(b: Box, p: Pt): Pt {
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (!dx && !dy) return c;
  const t = Math.min(
    dx ? b.w / 2 / Math.abs(dx) : Infinity,
    dy ? b.h / 2 / Math.abs(dy) : Infinity,
  );
  return { x: c.x + dx * Math.min(t, 1), y: c.y + dy * Math.min(t, 1) };
}

/**
 * A gently curved arrow from the edge of box `a` to the edge of box `b` (pixels), with
 * its head at `b`. Shared by live pointers and saved marks.
 */
export function connectorPath(a: Box, b: Box, gap = 4) {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const s0 = exitPoint(a, cb);
  const e0 = exitPoint(b, ca);
  const len = Math.hypot(e0.x - s0.x, e0.y - s0.y) || 1;
  const ux = (e0.x - s0.x) / len;
  const uy = (e0.y - s0.y) / len;
  const s = { x: s0.x + ux * gap, y: s0.y + uy * gap };
  const e = { x: e0.x - ux * gap, y: e0.y - uy * gap };
  // Bend sideways a little so parallel connectors stay apart and read as hand drawn.
  const bend = Math.min(40, len * 0.15);
  const q = { x: (s.x + e.x) / 2 - uy * bend, y: (s.y + e.y) / 2 + ux * bend };
  const angle = Math.atan2(e.y - q.y, e.x - q.x);
  const head = 10;
  const p1 = `${e.x - head * Math.cos(angle - 0.45)},${e.y - head * Math.sin(angle - 0.45)}`;
  const p2 = `${e.x - head * Math.cos(angle + 0.45)},${e.y - head * Math.sin(angle + 0.45)}`;
  return { d: `M${s.x},${s.y} Q${q.x},${q.y} ${e.x},${e.y}`, head: `${e.x},${e.y} ${p1} ${p2}` };
}

/** Text of the page inside a normalised rectangle (what one of Claude's marks covers). */
export function textInRect(layers: PageLayers, rect: NormRect): string {
  if (!layers.textLayer || !layers.pageEl) return '';
  const page = layers.pageEl.getBoundingClientRect();
  if (!page.width || !page.height) return '';
  const pad = 0.005;
  const out: string[] = [];
  for (const span of layers.textLayer.querySelectorAll('span')) {
    if (span.children.length) continue;
    const r = span.getBoundingClientRect();
    const cx = (r.left + r.width / 2 - page.left) / page.width;
    const cy = (r.top + r.height / 2 - page.top) / page.height;
    if (
      cx >= rect.x - pad &&
      cx <= rect.x + rect.w + pad &&
      cy >= rect.y - pad &&
      cy <= rect.y + rect.h + pad &&
      span.textContent?.trim()
    ) {
      out.push(span.textContent.trim());
    }
  }
  return out.join(' ').slice(0, 8000);
}

const BUBBLE_W = 190;

/** One mark, in CSS pixels of the page (`w`×`h`). */
function Mark({
  r,
  w,
  h,
  delay,
  index,
}: {
  r: Resolved;
  w: number;
  h: number;
  delay: number;
  /** Position among the group's numbered badges (their number when none is given). */
  index: number;
}) {
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
      if (r.to) {
        const c = connectorPath(
          { x: bx, y: by, w: bw, h: bh },
          {
            x: r.to.x * w - pad,
            y: r.to.y * h - pad,
            w: r.to.w * w + pad * 2,
            h: r.to.h * h + pad * 2,
          },
        );
        shape = (
          <g>
            <path d={c.d} pathLength={1} className="pointer-draw" style={style} />
            <polygon points={c.head} fill={CLAUDE} className="pointer-fade" style={style} />
          </g>
        );
        break;
      }
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
    case 'number': {
      // In the left margin of the passage, like the number of a step.
      const cx = Math.max(12, bx - 14);
      const cy = Math.max(12, by + bh / 2);
      shape = (
        <g className="pointer-fade" style={style}>
          <circle cx={cx} cy={cy} r={11} fill={CLAUDE} stroke="white" strokeWidth={2} />
          <text
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            fill="white"
            stroke="none"
            fontSize={12}
            fontWeight={700}
          >
            {(r.shape.label ?? String(index)).slice(0, 3)}
          </text>
        </g>
      );
      break;
    }
    case 'callout': {
      // Beside the passage where there is room (right, then left), else below it.
      const right = w - (bx + bw) > BUBBLE_W + 16;
      const left = !right && bx > BUBBLE_W + 16;
      const tx = right
        ? bx + bw + 14
        : left
          ? bx - BUBBLE_W - 14
          : Math.min(Math.max(4, bx), w - BUBBLE_W - 4);
      // Below the row of buttons (? and ×) that sits over the top right corner.
      const ty = right || left ? by + 8 : by + bh + 14;
      const sx = right ? bx + bw : left ? bx : bx + bw / 2;
      const sy = right || left ? by + bh / 2 : by + bh;
      const ex = right ? tx : left ? tx + BUBBLE_W : tx + 24;
      const ey = right || left ? ty + 14 : ty;
      shape = (
        <g>
          <rect
            x={bx}
            y={by}
            width={bw}
            height={bh}
            rx={6}
            strokeDasharray="5 4"
            className="pointer-fade"
            style={style}
          />
          <path d={`M${sx},${sy} L${ex},${ey}`} className="pointer-fade" style={style} />
          <foreignObject
            x={tx}
            y={ty}
            width={BUBBLE_W}
            height={200}
            className="pointer-fade overflow-visible"
            style={style}
          >
            <span
              className="bg-surface text-text inline-block max-w-full rounded-lg border-2 px-2 py-1 text-xs leading-snug shadow"
              style={{ borderColor: CLAUDE }}
              data-testid="pointer-callout"
            >
              {r.shape.label}
            </span>
          </foreignObject>
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
      {r.shape.label && r.shape.type !== 'callout' && r.shape.type !== 'number' && (
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
        const to =
          shape.type === 'arrow' && shape.to ? unionRect(resolveAnchor(shape.to, layers)) : null;
        if (box) marks.push({ shape, rects, box, ...(to && { to }) });
      }
      out.push({ group, marks });
    }
    return out;
  }, [groups, layers]);

  // While Claude answers (or reads the answer aloud) the marks stay bright; afterwards
  // they fade back so they no longer cover the page.
  const answering = useChat((s) => s.running);
  const talking = useVoice((s) => s.phase === 'thinking' || s.phase === 'speaking');
  const clear = useChat((s) => s.clearPointers);

  const marks = resolved.flatMap(({ group, marks }) => {
    let n = 0;
    return marks.map((m) => ({ group, m, index: m.shape.type === 'number' ? ++n : 0 }));
  });

  /** "?" next to a set of marks: ask Claude about what it marked there. */
  const ask = (group: PointerGroup, rects: NormRect[]) => {
    const box = unionRect(rects);
    if (!box) return;
    const labels = group.shapes
      .map((s) => s.label)
      .filter(Boolean)
      .join(' · ');
    useChat.getState().attachPointed({
      page: group.page,
      rect: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        w: Math.min(1, box.w),
        h: Math.min(1, box.h),
      },
      ...(labels && { labels: labels.slice(0, 1000) }),
      text: textInRect(layers, box),
    });
    useChatDock.getState().show();
    window.dispatchEvent(new CustomEvent('pca:focus-composer'));
  };
  if (!marks.length) return null;
  return (
    <div
      className="pointer-layer pointer-events-none absolute inset-0"
      data-rest={!answering && !talking}
    >
      <svg
        aria-hidden
        className="absolute inset-0 overflow-visible"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        fill="none"
        stroke={CLAUDE}
        strokeWidth={2.5}
        strokeLinecap="round"
        data-testid="claude-pointers"
      >
        {marks.map(({ group, m, index }, i) => (
          <Mark
            key={`${group.messageId}-${group.id}-${i}`}
            r={m}
            w={width}
            h={height}
            delay={i * 180}
            index={index}
          />
        ))}
      </svg>
      {resolved.map(({ group, marks }) => {
        const box = unionRect(marks.map((m) => m.box));
        if (!box) return null;
        return (
          <div
            key={`${group.messageId}-${group.id}`}
            className="pointer-events-none absolute flex -translate-y-1/2 gap-1"
            style={{
              left: `min(calc(${(box.x + box.w) * 100}% + 4px), calc(100% - 56px))`,
              top: `max(calc(${box.y * 100}% - 10px), 14px)`,
            }}
          >
            <button
              type="button"
              data-annotation-ui
              aria-label={t.chat.pointers.ask}
              title={t.chat.pointers.ask}
              onClick={(e) => {
                e.stopPropagation();
                ask(
                  group,
                  marks.map((m) => m.box),
                );
              }}
              className="pointer-dismiss pointer-events-auto flex size-6 items-center justify-center rounded-full text-white shadow"
              style={{ background: CLAUDE }}
              data-testid="pointer-ask"
            >
              <MessageCircleQuestion size={14} aria-hidden />
            </button>
            <button
              type="button"
              data-annotation-ui
              aria-label={t.chat.pointers.dismiss}
              title={t.chat.pointers.dismiss}
              onClick={(e) => {
                e.stopPropagation();
                clear(group.messageId);
              }}
              className="pointer-dismiss pointer-events-auto flex size-6 items-center justify-center rounded-full text-white shadow"
              style={{ background: CLAUDE }}
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
