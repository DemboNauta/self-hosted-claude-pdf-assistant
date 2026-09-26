import { Maximize, Minus, Plus } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { t } from '../../i18n';

interface View {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * Free pan and zoom over content of a known size, without scrollbars: the mouse wheel
 * (or a trackpad pinch) zooms around the pointer, dragging moves, two fingers pinch
 * on touch screens, double click zooms in. Keyboard: + / − / 0 and the arrow keys.
 */
export function PanZoom({
  width,
  height,
  label,
  children,
}: {
  /** Natural size of the content, in px. */
  width: number;
  height: number;
  label: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null);

  /** Whole diagram visible and centred (never enlarged beyond 2.5×). */
  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !width || !height) return;
    const scale = clampScale(
      Math.min(2.5, (el.clientWidth * 0.95) / width, (el.clientHeight * 0.95) / height),
    );
    setView({
      scale,
      x: (el.clientWidth - width * scale) / 2,
      y: (el.clientHeight - height * scale) / 2,
    });
  }, [width, height]);

  useLayoutEffect(() => fit(), [fit]);

  /** Zoom by `factor` keeping the point (px, py) of the box where it is. */
  const zoomAt = (factor: number, px: number, py: number) =>
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });

  const center = () => {
    const el = box.current!;
    return { x: el.clientWidth / 2, y: el.clientHeight / 2 };
  };

  // Wheel listener must be non-passive to stop the page from scrolling.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Trackpad pinches arrive as ctrl+wheel with small deltas: zoom faster for them.
      const speed = e.ctrlKey ? 0.01 : 0.0015;
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(-delta * speed), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const local = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer already gone (or synthetic): dragging still works while it is over the box.
    }
    pointers.current.set(e.pointerId, local(e));
    gesture.current = null;
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const all = [...pointers.current.values()];
    if (all.length >= 2) {
      // Two fingers: zoom by the change in their distance, pan with their midpoint.
      const [a, b] = all as [typeof p, typeof p];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const g = gesture.current;
      gesture.current = { dist, mid };
      if (!g || !g.dist) return;
      setView((v) => {
        const scale = clampScale(v.scale * (dist / g.dist));
        const k = scale / v.scale;
        return {
          scale,
          x: mid.x - (g.mid.x - v.x) * k,
          y: mid.y - (g.mid.y - v.y) * k,
        };
      });
      return;
    }
    setView((v) => ({ ...v, x: v.x + p.x - prev.x, y: v.y + p.y - prev.y }));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    gesture.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const c = center();
    const step = 60;
    const actions: Record<string, () => void> = {
      '+': () => zoomAt(1.25, c.x, c.y),
      '=': () => zoomAt(1.25, c.x, c.y),
      '-': () => zoomAt(0.8, c.x, c.y),
      '0': fit,
      ArrowLeft: () => setView((v) => ({ ...v, x: v.x + step })),
      ArrowRight: () => setView((v) => ({ ...v, x: v.x - step })),
      ArrowUp: () => setView((v) => ({ ...v, y: v.y + step })),
      ArrowDown: () => setView((v) => ({ ...v, y: v.y - step })),
    };
    const run = actions[e.key];
    if (run) {
      e.preventDefault();
      run();
    }
  };

  const button =
    'bg-surface border-border text-text-muted hover:text-text flex size-9 items-center justify-center rounded-lg border shadow-sm';

  return (
    <div
      ref={box}
      role="application"
      aria-label={label}
      aria-roledescription={t.diagrams.canvas}
      tabIndex={0}
      data-testid="diagram-canvas"
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        const p = local(e as unknown as PointerEvent);
        zoomAt(1.6, p.x, p.y);
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width,
          height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        {children}
      </div>
      <div className="absolute right-3 bottom-3 flex gap-1.5">
        <button
          type="button"
          onClick={() => zoomAt(0.8, center().x, center().y)}
          aria-label={t.diagrams.zoomOut}
          title={t.diagrams.zoomOut}
          className={button}
        >
          <Minus size={16} aria-hidden />
        </button>
        <button
          type="button"
          onClick={fit}
          aria-label={t.diagrams.fit}
          title={t.diagrams.fit}
          className={button}
        >
          <Maximize size={16} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => zoomAt(1.25, center().x, center().y)}
          aria-label={t.diagrams.zoomIn}
          title={t.diagrams.zoomIn}
          className={button}
        >
          <Plus size={16} aria-hidden />
        </button>
      </div>
      <span className="text-text-muted pointer-events-none absolute bottom-3 left-3 text-xs">
        {Math.round(view.scale * 100)}%
      </span>
    </div>
  );
}
