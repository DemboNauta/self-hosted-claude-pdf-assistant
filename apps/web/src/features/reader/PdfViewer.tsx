import type { PageSize } from '@pdfclaudeassistant/shared';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { t } from '../../i18n';
import type { PDFDocumentProxy } from './pdf';
import { PdfPage, type PageLayers } from './PdfPage';
import { MAX_SCALE, MIN_SCALE, useReader } from './store';

const GAP = 16;
const PAD = 16;
/** Pages rendered beyond the visible ones, on each side (SPEC §15). */
const OVERSCAN = 2;
const SAVE_DELAY_MS = 1500;

export interface ReadingPositionUpdate {
  page: number;
  scroll: number;
  viewed: number[];
}

interface Layout {
  tops: number[];
  widths: number[];
  heights: number[];
  total: number;
  innerWidth: number;
  scale: number;
}

function computeLayout(sizes: PageSize[], scale: number, viewportWidth: number): Layout {
  const tops: number[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  let y = PAD;
  let maxW = 0;
  for (const s of sizes) {
    tops.push(y);
    widths.push(s.width * scale);
    heights.push(s.height * scale);
    y += s.height * scale + GAP;
    maxW = Math.max(maxW, s.width * scale);
  }
  return {
    tops,
    widths,
    heights,
    total: y - GAP + PAD,
    innerWidth: Math.max(viewportWidth, maxW + 2 * PAD),
    scale,
  };
}

/** Index of the last page whose top is <= y (pages are sorted by top). */
function pageAt(layout: Layout, y: number): number {
  let lo = 0;
  let hi = layout.tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Scale fitting the widest page (fit-width) or the current page (fit-page). */
function fitScale(
  mode: 'fit-width' | 'fit-page',
  sizes: PageSize[],
  page: number,
  w: number,
  h: number,
) {
  const availW = Math.max(100, w - 2 * PAD);
  const maxWidth = Math.max(...sizes.map((s) => s.width));
  if (mode === 'fit-width') return availW / maxWidth;
  const s = sizes[page - 1] ?? sizes[0]!;
  return Math.min(availW / s.width, Math.max(100, h - 2 * PAD) / s.height);
}

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * Virtualised continuous-scroll viewer (F-VIS-01): the layout comes from the stored
 * page sizes, so only pages near the viewport are rendered.
 */
export function PdfViewer({
  pdf,
  pageSizes,
  initialPage,
  initialScroll,
  onPosition,
  overlay,
  onScroller,
}: {
  pdf: PDFDocumentProxy;
  pageSizes: PageSize[];
  initialPage: number;
  initialScroll: number;
  onPosition: (pos: ReadingPositionUpdate) => void;
  overlay?: (pageNumber: number, layers: PageLayers) => ReactNode;
  /** Receives the scroll container (selection menu, pointer overlays). */
  onScroller?: (el: HTMLDivElement | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const zoomMode = useReader((s) => s.zoomMode);
  const scale = useReader((s) => s.scale);
  const nav = useReader((s) => s.nav);
  const { setScale, setCurrentPage, setZoom } = useReader.getState();

  const layout = useMemo(
    () => computeLayout(pageSizes, scale, viewport.w),
    [pageSizes, scale, viewport.w],
  );
  const layoutRef = useRef(layout);
  /**
   * Point to keep still across a zoom: page index, fraction inside it, viewport offset
   * and the scale it is meant for (applied only by the relayout at that scale).
   */
  const anchor = useRef<{
    page: number;
    fx: number;
    fy: number;
    vx: number;
    vy: number;
    scale: number;
  } | null>(null);
  const restored = useRef(false);
  const viewed = useRef(new Set<number>());

  // Track the viewport size (fit modes and horizontal centring depend on it).
  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    onScroller?.(el);
    return () => {
      ro.disconnect();
      onScroller?.(null);
    };
  }, [onScroller]);

  const captureAnchor = useCallback((vx: number, vy: number, nextScale: number) => {
    const el = scroller.current;
    const l = layoutRef.current;
    anchor.current = null;
    // Same scale: nothing will relayout, and a pending anchor would fire much later.
    if (!el || l.tops.length === 0 || Math.abs(nextScale - l.scale) < 1e-6) return;
    const y = el.scrollTop + vy;
    const i = pageAt(l, y);
    const left = (l.innerWidth - l.widths[i]!) / 2;
    anchor.current = {
      page: i,
      fx: (el.scrollLeft + vx - left) / l.widths[i]!,
      fy: (y - l.tops[i]!) / l.heights[i]!,
      vx,
      vy,
      scale: nextScale,
    };
  }, []);

  /** Zoom keeping the point under (vx, vy) — or the viewport centre — in place. */
  const zoomTo = useCallback(
    (next: number, focus?: { vx: number; vy: number }) => {
      const el = scroller.current;
      if (!el) return;
      const scale = clampScale(next);
      captureAnchor(focus?.vx ?? el.clientWidth / 2, focus?.vy ?? 0, scale);
      setZoom('custom', scale);
    },
    [captureAnchor, setZoom],
  );

  // Fit modes follow the viewport size.
  useEffect(() => {
    if (zoomMode === 'custom' || viewport.w === 0 || pageSizes.length === 0) return;
    const el = scroller.current;
    const next = fitScale(
      zoomMode,
      pageSizes,
      useReader.getState().currentPage,
      viewport.w,
      viewport.h,
    );
    if (el && restored.current) captureAnchor(el.clientWidth / 2, 0, next);
    setScale(next);
  }, [zoomMode, viewport.w, viewport.h, pageSizes, setScale, captureAnchor]);

  // Apply the anchor (zoom) or the saved reading position (first layout) after a relayout.
  useLayoutEffect(() => {
    layoutRef.current = layout;
    const el = scroller.current;
    if (!el || viewport.w === 0) return;
    if (!restored.current) {
      const i = Math.min(Math.max(initialPage, 1), pageSizes.length) - 1;
      el.scrollTop = layout.tops[i]! + initialScroll * layout.heights[i]! - PAD / 2;
      restored.current = true;
      setScrollTop(el.scrollTop);
      return;
    }
    const a = anchor.current;
    if (!a || Math.abs(a.scale - layout.scale) > 1e-6) return;
    anchor.current = null;
    const left = (layout.innerWidth - layout.widths[a.page]!) / 2;
    el.scrollTop = layout.tops[a.page]! + a.fy * layout.heights[a.page]! - a.vy;
    el.scrollLeft = left + a.fx * layout.widths[a.page]! - a.vx;
    setScrollTop(el.scrollTop);
  }, [layout, viewport.w, initialPage, initialScroll, pageSizes.length]);

  // Navigation requests (page input, outline, search, citations).
  useEffect(() => {
    const el = scroller.current;
    if (!nav || !el || !restored.current) return;
    const i = nav.page - 1;
    const l = layoutRef.current;
    // With a quote, the highlight then scrolls itself into view (see PdfPage).
    el.scrollTo({ top: l.tops[i]! - PAD / 2 });
  }, [nav]);

  // Current page, viewed pages and debounced position saving.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !restored.current || layout.tops.length === 0) return;
    const probe = scrollTop + viewport.h * 0.3;
    setCurrentPage(pageAt(layout, probe) + 1);

    const top = scrollTop;
    const bottom = scrollTop + viewport.h;
    for (let i = pageAt(layout, top); i < layout.tops.length && layout.tops[i]! < bottom; i++) {
      const visible =
        Math.min(bottom, layout.tops[i]! + layout.heights[i]!) - Math.max(top, layout.tops[i]!);
      if (visible >= Math.min(layout.heights[i]!, viewport.h) * 0.5) viewed.current.add(i + 1);
    }

    const timer = setTimeout(() => {
      const i = pageAt(layout, scrollTop + PAD / 2);
      const frac = (scrollTop + PAD / 2 - layout.tops[i]!) / layout.heights[i]!;
      onPosition({
        page: i + 1,
        scroll: Math.min(1, Math.max(0, frac)),
        viewed: [...viewed.current].slice(0, 200),
      });
      viewed.current.clear();
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [scrollTop, layout, viewport.h, onPosition, setCurrentPage]);

  // Ctrl/⌘ + wheel (and trackpad pinch) zoom around the pointer.
  useEffect(() => {
    const el = scroller.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      zoomTo(useReader.getState().scale * Math.exp(-e.deltaY * 0.002), {
        vx: e.clientX - box.left,
        vy: e.clientY - box.top,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // Two-finger pinch on touch screens: preview with a CSS transform, commit on release.
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current!;
    let start: { dist: number; cx: number; cy: number } | null = null;
    let ratio = 1;
    const dist = (e: TouchEvent) =>
      Math.hypot(
        e.touches[0]!.clientX - e.touches[1]!.clientX,
        e.touches[0]!.clientY - e.touches[1]!.clientY,
      );
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const box = el.getBoundingClientRect();
      start = {
        dist: dist(e),
        cx: (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2 - box.left,
        cy: (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2 - box.top,
      };
      ratio = 1;
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      ratio = dist(e) / start.dist;
      const content = inner.current!;
      content.style.transformOrigin = `${el.scrollLeft + start.cx}px ${el.scrollTop + start.cy}px`;
      content.style.transform = `scale(${ratio})`;
    };
    const onEnd = () => {
      if (!start) return;
      inner.current!.style.transform = '';
      if (Math.abs(ratio - 1) > 0.02) {
        zoomTo(useReader.getState().scale * ratio, { vx: start.cx, vy: start.cy });
      }
      start = null;
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [zoomTo]);

  // Expose zoomTo for the toolbar through the store-less custom event below.
  useEffect(() => {
    const onZoom = (e: Event) => zoomTo((e as CustomEvent<number>).detail);
    window.addEventListener('pca:zoom', onZoom);
    return () => window.removeEventListener('pca:zoom', onZoom);
  }, [zoomTo]);

  const first = layout.tops.length ? pageAt(layout, scrollTop) : 0;
  const last = layout.tops.length ? pageAt(layout, scrollTop + viewport.h) : -1;
  const from = Math.max(0, first - OVERSCAN);
  const to = Math.min(layout.tops.length - 1, last + OVERSCAN);
  const visible: number[] = [];
  if (viewport.w > 0) for (let i = from; i <= to; i++) visible.push(i);

  return (
    <div
      ref={scroller}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      tabIndex={0}
      aria-label={t.reader.document}
      className="bg-surface-muted relative h-full overflow-auto overscroll-contain outline-none"
      data-testid="pdf-scroller"
      // Native pinch would zoom the whole app; the pinch handler above zooms the PDF.
      style={{ touchAction: 'pan-x pan-y' }}
    >
      <div
        ref={inner}
        className="relative"
        style={{ height: layout.total, width: layout.innerWidth }}
      >
        {visible.map((i) => (
          <PdfPage
            key={i}
            pdf={pdf}
            pageNumber={i + 1}
            scale={scale}
            width={layout.widths[i]!}
            height={layout.heights[i]!}
            style={{ top: layout.tops[i], left: (layout.innerWidth - layout.widths[i]!) / 2 }}
            overlay={overlay ? (layers) => overlay(i + 1, layers) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

/** Asks the mounted viewer to zoom to `scale`, keeping the view centred. */
export function requestZoom(scale: number) {
  window.dispatchEvent(new CustomEvent('pca:zoom', { detail: scale }));
}
