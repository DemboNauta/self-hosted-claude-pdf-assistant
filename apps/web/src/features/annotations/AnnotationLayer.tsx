import type {
  Annotation,
  DrawingAnchor,
  HighlightAnchor,
  NoteAnchor,
  ShapeAnchor,
  Stroke,
} from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { Image as ImageIcon, MessageSquare, StickyNote } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
  Fragment,
} from 'react';
import { t } from '../../i18n';
import type { PageLayers } from '../reader/PdfPage';
import { rangeRects } from '../reader/SelectionMenu';
import { connectorPath } from '../reader/PointerLayer';
import { useReader, type AnnotationFilter } from '../reader/store';
import type { NormRect } from '../reader/textMatch';
import {
  createAnnotations,
  deleteAnnotations,
  updateAnnotation,
  useAnnotations,
  usePalette,
} from './api';
import { AnnotationPopover } from './AnnotationPopover';
import { boardSnapshotUrl } from './api';
import { caretInLayer, rangeText, wordRange, type Caret } from './highlighter';
import { isMarginNote, MarginNotes } from './MarginNotes';
import { askAboutMark } from './mark';

export function isVisible(a: Annotation, f: AnnotationFilter) {
  if (!f.visible || a.status === 'rejected') return false;
  if (a.author === 'user' ? !f.mine : !f.claude) return false;
  return !f.hiddenColors.includes(a.color);
}

export function rectsOf(a: Annotation): NormRect[] {
  const anchor = a.anchor as { rects?: NormRect[] };
  return anchor.rects ?? [];
}

export function boxOf(a: Annotation): NormRect | null {
  if (a.type === 'note' && (a.anchor as NoteAnchor).kind === 'point') {
    const p = a.anchor as { x: number; y: number };
    return { x: p.x, y: p.y, w: 0, h: 0 };
  }
  if (a.type === 'drawing') {
    const pts = (a.anchor as DrawingAnchor).strokes.flatMap((s) => s.points);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  }
  const rects = rectsOf(a);
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}

/** Where a note's marker sits: its point, where it was moved, or the end of its passage. */
export function markerOf(a: Annotation, box: NormRect): { x: number; y: number } {
  const anchor = a.anchor as NoteAnchor;
  if (anchor.kind === 'point') return { x: anchor.x, y: anchor.y };
  if (anchor.pin) return anchor.pin;
  return { x: box.x + box.w, y: box.y };
}

const pct = (r: NormRect) => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.w * 100}%`,
  height: `${r.h * 100}%`,
});

/** Smooth SVG path through stroke points (quadratic curves through midpoints). */
export function strokePath(s: Stroke, w: number, h: number): string {
  const pts = s.points.map(([x, y]) => [x * w, y * h] as const);
  if (pts.length === 1) return `M${pts[0]![0]},${pts[0]![1]} l0.01,0`;
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    d += ` Q${x},${y} ${(x + nx) / 2},${(y + ny) / 2}`;
  }
  const last = pts.at(-1)!;
  return `${d} L${last[0]},${last[1]}`;
}

function strokeWidth(s: Stroke, w: number) {
  const avg = s.points.reduce((n, p) => n + p[2], 0) / s.points.length;
  return Math.max(1, s.width * w * (0.6 + avg * 0.8));
}

/** Highlights sit under the text layer so text stays selectable (PdfPage underlay). */
export function AnnotationUnderlay({ docId, page }: { docId: string; page: number }) {
  const { data } = useAnnotations(docId);
  const filter = useReader((s) => s.filter);
  const active = useReader((s) => s.activeAnnotation);
  const { colorOf } = usePalette();
  const items = (data ?? []).filter(
    (a) =>
      a.page === page &&
      (a.type === 'highlight' || (a.type === 'note' && (a.anchor as NoteAnchor).kind === 'text')) &&
      isVisible(a, filter),
  );
  return (
    // Blend mode and --hl-boost switch for dark PDF pages in styles.css.
    <div aria-hidden className="annotation-underlay pointer-events-none absolute inset-0">
      {items.flatMap((a) =>
        rectsOf(a).map((r, i) => (
          <div
            key={`${a.id}-${i}`}
            className={clsx(
              'absolute rounded-[2px]',
              a.status === 'proposed' && 'outline-2 outline-offset-1 outline-dashed',
            )}
            style={{
              ...pct(r),
              background: colorOf(a.color),
              opacity: `calc(var(--hl-boost) * ${
                a.type === 'note'
                  ? 0.25
                  : a.status === 'proposed'
                    ? 0.3
                    : a.id === active
                      ? 0.6
                      : 0.42
              })`,
              outlineColor: colorOf(a.color),
            }}
            data-annotation={a.id}
          />
        )),
      )}
    </div>
  );
}

/**
 * Everything above the text layer: notes, drawings, saved Claude marks, the popover
 * of the selected annotation and, with a drawing tool active, the input surface.
 */
export function AnnotationOverlay({
  docId,
  page,
  layers,
  width,
  height,
}: {
  docId: string;
  page: number;
  layers: PageLayers;
  width: number;
  height: number;
}) {
  const { data } = useAnnotations(docId);
  const filter = useReader((s) => s.filter);
  const tool = useReader((s) => s.tool);
  const active = useReader((s) => s.activeAnnotation);
  const setActive = useReader((s) => s.setActiveAnnotation);
  const { colorOf } = usePalette();
  const all = useMemo(() => (data ?? []).filter((a) => a.page === page), [data, page]);
  const visible = all.filter((a) => isVisible(a, filter));

  // Clicking highlighted text (without selecting) opens its popover.
  useEffect(() => {
    const el = layers.pageEl;
    if (!el || tool !== 'select') return;
    const onClick = (e: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      if ((e.target as HTMLElement).closest('[data-annotation-ui]')) return;
      const box = el.getBoundingClientRect();
      const x = (e.clientX - box.left) / box.width;
      const y = (e.clientY - box.top) / box.height;
      const hit = visible.find(
        (a) =>
          (a.type === 'highlight' || a.type === 'note') &&
          rectsOf(a).some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h),
      );
      setActive(hit?.id ?? null);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [layers.pageEl, tool, visible, setActive]);

  const drawings = visible.filter((a) => a.type === 'drawing');
  const shapes = visible.filter((a) => a.type === 'shape');
  const margin = visible.filter(isMarginNote);
  const notes = visible.filter((a) => a.type === 'note' && !isMarginNote(a));
  // Open note windows: the pinned ones plus the one the user just opened.
  const windows = visible.filter((a) => a.display?.pinned);
  const selected = all.find((a) => a.id === active);
  if (selected && tool === 'select' && !windows.includes(selected)) windows.push(selected);

  // Dragging a sticky note or a drawing (select tool): offset in page space while moving.
  const [move, setMove] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const moveStart = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const startMove = (a: Annotation) => (e: RPointerEvent<Element>) => {
    // Every note's marker can be moved (it may cover the text); drawings only the student's.
    if (tool !== 'select' || (a.type !== 'note' && a.author !== 'user')) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    moveStart.current = { id: a.id, x: e.clientX, y: e.clientY, moved: false };
  };
  const onMove = (e: RPointerEvent<Element>) => {
    const m = moveStart.current;
    if (!m) return;
    const dx = e.clientX - m.x;
    const dy = e.clientY - m.y;
    if (!m.moved && Math.hypot(dx, dy) < 4) return;
    m.moved = true;
    setMove({ id: m.id, dx: dx / width, dy: dy / height });
  };
  /** Ends a drag: saves the new position (undoable) or, without movement, opens the note. */
  const endMove = (a: Annotation) => () => {
    const m = moveStart.current;
    moveStart.current = null;
    if (!m) return;
    if (!m.moved || !move) {
      setActive(active === a.id ? null : a.id);
      return;
    }
    setMove(null);
    void updateAnnotation(docId, a, { anchor: translateAnchor(a, move.dx, move.dy) });
  };
  const cancelMove = () => {
    moveStart.current = null;
    setMove(null);
  };
  const offset = (a: Annotation) => (move?.id === a.id ? move : { dx: 0, dy: 0 });

  return (
    <>
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-visible"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {drawings.map((a) => {
          const o = offset(a);
          const movable = tool === 'select' && a.author === 'user';
          return (
            <g
              key={a.id}
              transform={o.dx || o.dy ? `translate(${o.dx * width},${o.dy * height})` : undefined}
              opacity={a.id === active ? 0.75 : 1}
            >
              {(a.anchor as DrawingAnchor).strokes.map((s, i) => (
                <path
                  key={i}
                  d={strokePath(s, width, height)}
                  stroke={s.color}
                  strokeWidth={strokeWidth(s, width)}
                />
              ))}
              {movable &&
                (a.anchor as DrawingAnchor).strokes.map((s, i) => (
                  // Wider invisible stroke: easy to grab with a finger; the page stays selectable.
                  <path
                    key={`hit-${i}`}
                    data-annotation-ui
                    data-drawing={a.id}
                    d={strokePath(s, width, height)}
                    stroke="transparent"
                    strokeWidth={Math.max(16, strokeWidth(s, width))}
                    className="cursor-move"
                    style={{ pointerEvents: 'stroke', touchAction: 'none' }}
                    onPointerDown={startMove(a)}
                    onPointerMove={onMove}
                    onPointerUp={endMove(a)}
                    onPointerCancel={cancelMove}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <title>{t.annotations.moveMark}</title>
                  </path>
                ))}
            </g>
          );
        })}
        {shapes.map((a) => {
          const s = a.anchor as ShapeAnchor;
          const b = boxOf(a);
          if (!b) return null;
          const c = colorOf(a.color);
          const pad = 5;
          const [x, y, w, h] = [
            b.x * width - pad,
            b.y * height - pad,
            b.w * width + 2 * pad,
            b.h * height + 2 * pad,
          ];
          if (s.shape === 'highlight') {
            return (s.rects ?? []).map((r, i) => (
              <rect
                key={`${a.id}-${i}`}
                x={r.x * width}
                y={r.y * height}
                width={r.w * width}
                height={r.h * height}
                fill={c}
                fillOpacity={0.25}
              />
            ));
          }
          if (s.shape === 'circle') {
            return (
              <ellipse
                key={a.id}
                cx={x + w / 2}
                cy={y + h / 2}
                rx={w / 2 + 4}
                ry={h / 2 + 4}
                stroke={c}
                strokeWidth={2}
              />
            );
          }
          if (s.shape === 'arrow' && s.to) {
            const link = connectorPath(
              { x, y, w, h },
              {
                x: s.to.x * width - pad,
                y: s.to.y * height - pad,
                w: s.to.w * width + 2 * pad,
                h: s.to.h * height + 2 * pad,
              },
            );
            return (
              <g key={a.id} stroke={c} strokeWidth={2}>
                <path d={link.d} />
                <polygon points={link.head} fill={c} />
              </g>
            );
          }
          if (s.shape === 'arrow') {
            return (
              <g key={a.id} stroke={c} strokeWidth={2}>
                <path
                  d={`M${x - 60},${y + h / 2 - 24} Q${x - 30},${y + h / 2 - 24} ${x},${y + h / 2}`}
                />
                <path
                  d={`M${x - 9},${y + h / 2 - 6} L${x},${y + h / 2} L${x - 10},${y + h / 2 + 3}`}
                />
              </g>
            );
          }
          if (s.shape === 'rect')
            return (
              <rect key={a.id} x={x} y={y} width={w} height={h} rx={5} stroke={c} strokeWidth={2} />
            );
          if (s.shape === 'callout')
            return (
              <rect
                key={a.id}
                x={x}
                y={y}
                width={w}
                height={h}
                rx={5}
                stroke={c}
                strokeWidth={2}
                strokeDasharray="4 4"
              />
            );
          if (s.shape === 'number')
            return (
              <g key={a.id}>
                <circle cx={Math.max(12, x - 14)} cy={Math.max(12, y + h / 2)} r={11} fill={c} />
                <text
                  x={Math.max(12, x - 14)}
                  y={Math.max(12, y + h / 2)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="white"
                  fontSize={12}
                  fontWeight={700}
                >
                  {(a.content ?? '•').slice(0, 3)}
                </text>
              </g>
            );
          return null;
        })}
      </svg>

      {shapes
        .filter((a) => a.content && (a.anchor as ShapeAnchor).shape !== 'number')
        .map((a) => {
          const b = boxOf(a)!;
          return (
            <span
              key={`${a.id}-label`}
              className="pointer-events-none absolute -translate-y-full rounded px-1.5 py-0.5 text-[11px] font-medium text-white"
              style={{
                left: `${b.x * 100}%`,
                top: `calc(${b.y * 100}% - 6px)`,
                background: colorOf(a.color),
              }}
            >
              {a.content}
            </span>
          );
        })}

      {notes.map((a) => {
        const b = boxOf(a);
        if (!b) return null;
        const movable = tool === 'select';
        const o = offset(a);
        const at = markerOf(a, b);
        const pinned =
          (a.anchor as NoteAnchor).kind === 'text' &&
          (o.dx || o.dy || at.x !== b.x + b.w || at.y !== b.y);
        return (
          <Fragment key={a.id}>
            {pinned && (
              // A marker moved away from its passage keeps a thin line to it.
              <svg
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-visible"
                width={width}
                height={height}
              >
                <line
                  x1={(b.x + b.w) * width}
                  y1={(b.y + b.h / 2) * height}
                  x2={(at.x + o.dx) * width}
                  y2={(at.y + o.dy) * height}
                  stroke={colorOf(a.color)}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
              </svg>
            )}
            <button
              type="button"
              data-annotation-ui
              aria-label={a.board ? t.annotations.board.marker : t.annotations.openNote}
              title={[a.content, movable ? t.annotations.moveHint : ''].filter(Boolean).join(' · ')}
              data-note-marker={a.id}
              {...(movable && {
                onPointerDown: startMove(a),
                onPointerMove: onMove,
                onPointerUp: endMove(a),
                onPointerCancel: cancelMove,
              })}
              onClick={(e) => {
                e.stopPropagation();
                // Pointer users of a movable note open it on release (endMove); keyboard here.
                if (!movable || e.detail === 0) setActive(active === a.id ? null : a.id);
              }}
              className={clsx(
                'absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-md text-white shadow',
                a.board ? 'p-0.5' : 'p-1',
                movable && 'cursor-move',
              )}
              style={{
                left: `${(at.x + o.dx) * 100}%`,
                top: `${(at.y + o.dy) * 100}%`,
                background: colorOf(a.color),
                ...(movable && { touchAction: 'none' as const }),
              }}
            >
              {a.board ? (
                // A note holding a whiteboard shows a small picture of it on the page.
                <img
                  src={boardSnapshotUrl(a.board)}
                  alt=""
                  draggable={false}
                  className="block h-8 w-12 rounded-sm bg-white object-contain"
                  onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
                />
              ) : a.images.length ? (
                <ImageIcon size={14} aria-hidden />
              ) : (
                <StickyNote size={14} aria-hidden />
              )}
            </button>
          </Fragment>
        );
      })}

      <MarginNotes
        docId={docId}
        notes={margin}
        layers={layers}
        width={width}
        height={height}
        boxOf={boxOf}
      />

      {tool !== 'select' && (
        <InputSurface docId={docId} page={page} items={visible} width={width} height={height} />
      )}

      {windows.map((a) => (
        <AnnotationPopover
          key={a.id}
          docId={docId}
          annotation={a}
          box={boxOf(a)}
          pageWidth={width}
          pageHeight={height}
          focused={a.id === active}
          onFocus={() => setActive(a.id)}
          onClose={() => {
            if (active === a.id) setActive(null);
          }}
          extraActions={
            a.type === 'drawing' && (
              <button
                type="button"
                onClick={() => {
                  if (askAboutMark(docId, a.page, [a.id])) setActive(null);
                }}
                className="hover:bg-surface-muted flex items-center gap-1 rounded-md px-2 py-1"
              >
                <MessageSquare size={14} aria-hidden />
                {t.chat.selection.ask}
              </button>
            )
          }
        />
      ))}
    </>
  );
}

/** The anchor of a sticky note or drawing moved by (dx, dy) in page space. */
function translateAnchor(a: Annotation, dx: number, dy: number): Annotation['anchor'] {
  const unit = (v: number) => Math.min(1, Math.max(0, v));
  if (a.type === 'note') {
    const anchor = a.anchor as NoteAnchor;
    // A note on a passage keeps it: only its marker moves.
    if (anchor.kind === 'text') {
      const at = markerOf(a, boxOf(a) ?? { x: 0, y: 0, w: 0, h: 0 });
      return { ...anchor, pin: { x: unit(at.x + dx), y: unit(at.y + dy) } };
    }
    return { kind: 'point', x: unit(anchor.x + dx), y: unit(anchor.y + dy) };
  }
  const d = a.anchor as DrawingAnchor;
  return {
    strokes: d.strokes.map((s) => ({
      ...s,
      points: s.points.map(([x, y, p]): [number, number, number] => [x + dx, y + dy, p]),
    })),
  };
}

/**
 * Highlighter, pen, eraser and note-pin input (F-ANN-01/02/03), with pen pressure when
 * available.
 */
function InputSurface({
  docId,
  page,
  items,
  width,
  height,
}: {
  docId: string;
  page: number;
  items: Annotation[];
  width: number;
  height: number;
}) {
  const tool = useReader((s) => s.tool);
  const pen = useReader((s) => s.pen);
  const setActive = useReader((s) => s.setActiveAnnotation);
  const setTool = useReader((s) => s.setTool);
  const [live, setLive] = useState<Stroke | null>(null);
  const drawing = useRef<Stroke | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const highlightColor = useReader((s) => s.highlightColor);
  const { colorOf } = usePalette();
  const marking = useRef<{ start: Caret; range: Range | null } | null>(null);
  const [marked, setMarked] = useState<NormRect[]>([]);

  /** The caret under the pointer in this page's text layer (looking through the surface). */
  const caretAt = (e: RPointerEvent): Caret | null => {
    const el = surface.current!;
    const layer = el.closest('[data-page]')?.querySelector<HTMLElement>('.textLayer');
    if (!layer) return null;
    el.style.pointerEvents = 'none';
    try {
      return caretInLayer(layer, e.clientX, e.clientY);
    } finally {
      el.style.pointerEvents = '';
    }
  };

  const markTo = (e: RPointerEvent) => {
    const m = marking.current;
    const end = m && caretAt(e);
    const pageEl = surface.current!.closest<HTMLElement>('[data-page]');
    if (!m || !end || !pageEl) return;
    m.range = wordRange(m.start, end);
    setMarked(rangeRects(m.range, pageEl));
  };

  const finishMark = () => {
    const m = marking.current;
    marking.current = null;
    const rects = marked;
    setMarked([]);
    const quote = m?.range ? rangeText(m.range) : '';
    if (quote.length < 2 || !rects.length) return;
    void createAnnotations(docId, [
      {
        type: 'highlight',
        page,
        color: highlightColor,
        anchor: { quote: quote.slice(0, 8000), rects: rects.slice(0, 200) },
      },
    ]);
  };

  const at = (e: RPointerEvent): [number, number, number] => {
    const box = surface.current!.getBoundingClientRect();
    const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;
    return [(e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height, pressure];
  };

  const eraseAt = (x: number, y: number) => {
    const tol = 12 / width;
    const hit = items.find(
      (a) =>
        a.type === 'drawing' &&
        (a.anchor as DrawingAnchor).strokes.some((s) =>
          s.points.some((p) => Math.hypot(p[0] - x, (p[1] - y) * (height / width)) < tol),
        ),
    );
    if (hit) void deleteAnnotations(docId, [hit]);
  };

  return (
    <div
      ref={surface}
      data-annotation-ui
      className={clsx(
        'absolute inset-0 z-20',
        tool === 'erase'
          ? 'cursor-cell'
          : tool === 'note'
            ? 'cursor-copy'
            : tool === 'highlight'
              ? 'cursor-text'
              : 'cursor-crosshair',
      )}
      style={{ touchAction: 'none' }}
      onPointerDown={(e) => {
        e.preventDefault();
        const [x, y, p] = at(e);
        if (tool === 'note') {
          void createAnnotations(docId, [
            { type: 'note', page, color: 'yellow', content: '', anchor: { kind: 'point', x, y } },
          ]).then(([created]) => {
            setTool('select');
            if (created) setActive(created.id);
          });
          return;
        }
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        if (tool === 'highlight') {
          const start = caretAt(e);
          marking.current = start ? { start, range: null } : null;
          if (start) markTo(e);
          return;
        }
        if (tool === 'erase') {
          eraseAt(x, y);
          drawing.current = { points: [[x, y, p]], width: pen.width, color: pen.color };
          return;
        }
        drawing.current = { points: [[x, y, p]], width: pen.width, color: pen.color };
        setLive(drawing.current);
      }}
      onPointerMove={(e) => {
        if (tool === 'highlight') return markTo(e);
        const d = drawing.current;
        if (!d) return;
        const [x, y, p] = at(e);
        if (tool === 'erase') return eraseAt(x, y);
        const last = d.points.at(-1)!;
        if (Math.hypot(x - last[0], y - last[1]) < 0.0015) return;
        d.points.push([x, y, p]);
        setLive({ ...d, points: [...d.points] });
      }}
      onPointerUp={() => {
        if (tool === 'highlight') return finishMark();
        const d = drawing.current;
        drawing.current = null;
        setLive(null);
        if (!d || tool !== 'draw') return;
        void createAnnotations(docId, [
          { type: 'drawing', page, color: d.color, anchor: { strokes: [d] } },
        ]).then(([created]) => {
          if (created) useReader.getState().addDrawn(page, created.id);
        });
      }}
      onPointerCancel={() => {
        marking.current = null;
        setMarked([]);
        drawing.current = null;
        setLive(null);
      }}
    >
      {marked.map((r, i) => (
        <div
          key={i}
          aria-hidden
          data-testid="highlighter-preview"
          className="pointer-events-none absolute rounded-[2px] opacity-40 mix-blend-multiply"
          style={{
            left: r.x * width,
            top: r.y * height,
            width: r.w * width,
            height: r.h * height,
            background: colorOf(highlightColor),
          }}
        />
      ))}
      {live && (
        <svg
          className="pointer-events-none absolute inset-0"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path
            d={strokePath(live, width, height)}
            stroke={live.color}
            strokeWidth={strokeWidth(live, width)}
          />
        </svg>
      )}
    </div>
  );
}

export type { HighlightAnchor };
