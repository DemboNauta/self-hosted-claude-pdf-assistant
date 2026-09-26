import type {
  Annotation,
  DrawingAnchor,
  HighlightAnchor,
  NoteAnchor,
  ShapeAnchor,
  Stroke,
} from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { MessageSquare, StickyNote } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { t } from '../../i18n';
import type { PageLayers } from '../reader/PdfPage';
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
    <div aria-hidden className="pointer-events-none absolute inset-0 mix-blend-multiply">
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
              opacity:
                a.type === 'note'
                  ? 0.25
                  : a.status === 'proposed'
                    ? 0.3
                    : a.id === active
                      ? 0.6
                      : 0.42,
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
  const notes = visible.filter((a) => a.type === 'note');
  // Open note windows: the pinned ones plus the one the user just opened.
  const windows = visible.filter((a) => a.display?.pinned);
  const selected = all.find((a) => a.id === active);
  if (selected && tool === 'select' && !windows.includes(selected)) windows.push(selected);

  // Dragging a sticky note or a drawing (select tool): offset in page space while moving.
  const [move, setMove] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const moveStart = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const startMove = (a: Annotation) => (e: RPointerEvent<Element>) => {
    if (tool !== 'select' || a.author !== 'user') return;
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
          return null;
        })}
      </svg>

      {shapes
        .filter((a) => a.content)
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
        const point = (a.anchor as NoteAnchor).kind === 'point';
        const movable = point && tool === 'select' && a.author === 'user';
        const o = offset(a);
        return (
          <button
            key={a.id}
            type="button"
            data-annotation-ui
            aria-label={t.annotations.openNote}
            title={a.content ?? ''}
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
              'absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-md p-1 text-white shadow',
              movable && 'cursor-move',
            )}
            style={{
              left: `${((point ? b.x : b.x + b.w) + o.dx) * 100}%`,
              top: `${(b.y + o.dy) * 100}%`,
              background: colorOf(a.color),
              ...(movable && { touchAction: 'none' as const }),
            }}
          >
            <StickyNote size={14} aria-hidden />
          </button>
        );
      })}

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
    const p = a.anchor as { x: number; y: number };
    return { kind: 'point', x: unit(p.x + dx), y: unit(p.y + dy) };
  }
  const d = a.anchor as DrawingAnchor;
  return {
    strokes: d.strokes.map((s) => ({
      ...s,
      points: s.points.map(([x, y, p]): [number, number, number] => [x + dx, y + dy, p]),
    })),
  };
}

/** Pen, eraser and note-pin input (F-ANN-02, F-ANN-03), with pen pressure when available. */
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
        tool === 'erase' ? 'cursor-cell' : tool === 'note' ? 'cursor-copy' : 'cursor-crosshair',
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
        if (tool === 'erase') {
          eraseAt(x, y);
          drawing.current = { points: [[x, y, p]], width: pen.width, color: pen.color };
          return;
        }
        drawing.current = { points: [[x, y, p]], width: pen.width, color: pen.color };
        setLive(drawing.current);
      }}
      onPointerMove={(e) => {
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
    >
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
