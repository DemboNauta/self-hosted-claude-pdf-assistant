import { RenderingCancelledException, TextLayer } from 'pdfjs-dist';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { MAX_CANVAS_PIXELS, type PDFDocumentProxy } from './pdf';
import { useReader } from './store';
import { findQuoteRects, type NormRect } from './textMatch';
import './textLayer.css';

const FLASH_MS = 4000;

export interface PageLayers {
  /** The page box (for converting client coordinates to page space). */
  pageEl: HTMLDivElement | null;
  /** The rendered PDF.js text layer, null until ready (a new element after each zoom). */
  textLayer: HTMLDivElement | null;
}

/**
 * One PDF page: canvas, selectable text layer and highlight overlays. Only mounted
 * for pages near the viewport (virtualisation, SPEC §15).
 */
export const PdfPage = memo(function PdfPage({
  pdf,
  pageNumber,
  scale,
  width,
  height,
  style,
  overlay,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  width: number;
  height: number;
  style: React.CSSProperties;
  overlay?: (layers: PageLayers) => ReactNode;
}) {
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null);
  const canvasBox = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [textLayerEl, setTextLayerEl] = useState<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    let textLayer: TextLayer | null = null;

    void (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const area = viewport.width * viewport.height;
      const outputScale = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / area));

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.className = 'absolute inset-0 size-full';
      canvas.setAttribute('aria-hidden', 'true');
      renderTask = page.render({
        canvas,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
      });
      await renderTask.promise;
      if (cancelled) return;
      // Swap only once drawn: while zooming the old bitmap stays (stretched) instead of blank.
      canvasBox.current?.replaceChildren(canvas);
      setRendered(true);

      const container = textRef.current;
      if (!container) return;
      const next = document.createElement('div');
      next.className = 'textLayer';
      textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: next,
        viewport,
      });
      await textLayer.render();
      if (cancelled) return;
      container.replaceChildren(next);
      setTextLayerEl(next);
    })().catch((err: unknown) => {
      if (!(err instanceof RenderingCancelledException) && !cancelled) console.error(err);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [pdf, pageNumber, scale]);

  const layers: PageLayers = { pageEl, textLayer: textLayerEl };

  return (
    <div
      ref={setPageEl}
      data-page={pageNumber}
      role="region"
      aria-label={t.reader.pageLabel(pageNumber)}
      className="absolute bg-white shadow-sm ring-1 ring-black/5"
      style={{
        ...style,
        width,
        height,
        ['--total-scale-factor' as string]: scale,
        ['--scale-round-x' as string]: '1px',
        ['--scale-round-y' as string]: '1px',
      }}
    >
      <div ref={canvasBox} className="absolute inset-0" />
      {!rendered && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
          {pageNumber}
        </div>
      )}
      <div ref={textRef} className="absolute inset-0" />
      <Highlights pageNumber={pageNumber} layers={layers} />
      {overlay?.(layers)}
    </div>
  );
});

/** Search matches and the temporary citation flash (F-VIS-02, F-VIS-03). */
function Highlights({ pageNumber, layers }: { pageNumber: number; layers: PageLayers }) {
  const flash = useReader((s) => (s.flash?.page === pageNumber ? s.flash : null));
  const terms = useReader((s) => s.searchTerms);
  const [expired, setExpired] = useState<number | null>(null);
  const { pageEl, textLayer } = layers;

  // Rectangles are measured from the rendered text layer, which changes on every zoom.
  const flashRects = useMemo(
    () =>
      flash && textLayer && pageEl ? (findQuoteRects(textLayer, pageEl, flash.quote)[0] ?? []) : [],
    [flash, textLayer, pageEl],
  );
  const termRects = useMemo(() => {
    if (!terms || !textLayer || !pageEl) return [];
    const words = terms.split(/\s+/).filter((w) => w.length >= 2);
    return words.flatMap((w) => findQuoteRects(textLayer, pageEl, w, { all: true }).flat());
  }, [terms, textLayer, pageEl]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setExpired(flash.nonce), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);
  const shownFlash = flash && flash.nonce !== expired ? flashRects : [];
  const shownTerms = termRects;

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {shownTerms.map((r, i) => (
        <div key={`t${i}`} className="absolute rounded-sm bg-yellow-300/50" style={toStyle(r)} />
      ))}
      {shownFlash.map((r, i) => (
        <div
          key={`f${i}`}
          className="animate-flash absolute rounded-sm bg-orange-400/45"
          style={toStyle(r)}
        />
      ))}
    </div>
  );
}

export function toStyle(r: NormRect): React.CSSProperties {
  return {
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.w * 100}%`,
    height: `${r.h * 100}%`,
  };
}
