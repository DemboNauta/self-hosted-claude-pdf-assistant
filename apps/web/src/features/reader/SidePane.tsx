import type { LibraryTree } from '@pdfclaudeassistant/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { AnnotationUnderlay } from '../annotations/AnnotationLayer';
import { libraryKey } from '../library/api';
import { PdfPage, type PageLayers } from './PdfPage';
import { PointerLayer } from './PointerLayer';
import { useReader } from './store';
import { usePdf } from './usePdf';

/** Title of a library document from the cached tree (null if unknown). */
export function documentTitle(tree: LibraryTree | undefined, docId: string): string | null {
  for (const s of tree?.subjects ?? []) {
    for (const tp of s.topics) {
      const d = tp.documents.find((x) => x.id === docId);
      if (d) return d.title;
    }
  }
  return null;
}

/**
 * Split view: one page of this or another document next to the reader, e.g. opened by
 * Claude to compare two places (`show_side_by_side`). Claude's marks on that page show
 * here too. Desktop only.
 */
export function SidePane() {
  const side = useReader((s) => s.side);
  const qc = useQueryClient();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const { pdf, error } = usePdf(side?.docId, !!side);
  const page = side ? Math.min(side.page, pdf?.numPages ?? side.page) : 1;
  const open = side !== null;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    void pdf.getPage(page).then(
      (p) => {
        const vp = p.getViewport({ scale: 1 });
        if (!cancelled) setSize({ w: vp.width, h: vp.height });
      },
      () => {
        /* the document was closed meanwhile */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pdf, page]);

  if (!side) return null;
  const title =
    documentTitle(qc.getQueryData<LibraryTree>(libraryKey), side.docId) ?? t.reader.side.title;
  const scale = size && width ? Math.max(0.2, (width - 32) / size.w) : 1;
  const w = size ? size.w * scale : 0;
  const h = size ? size.h * scale : 0;
  const { setSidePage, closeSide } = useReader.getState();

  return (
    <section
      aria-label={t.reader.side.label}
      className="border-border bg-surface-muted hidden min-w-0 flex-1 flex-col border-l lg:flex"
      data-testid="side-pane"
    >
      <header className="border-border bg-surface flex items-center gap-1 border-b px-2 py-1.5">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
          {title}
        </h2>
        <button
          type="button"
          onClick={() => setSidePage(page - 1)}
          disabled={page <= 1}
          aria-label={t.reader.side.prev}
          className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5 disabled:opacity-40"
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        <span className="text-text-muted text-xs tabular-nums" data-testid="side-page">
          {t.reader.side.page(page, pdf?.numPages ?? null)}
        </span>
        <button
          type="button"
          onClick={() => setSidePage(page + 1)}
          disabled={!!pdf && page >= pdf.numPages}
          aria-label={t.reader.side.next}
          className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5 disabled:opacity-40"
        >
          <ChevronRight size={16} aria-hidden />
        </button>
        <button
          type="button"
          onClick={closeSide}
          aria-label={t.reader.side.close}
          title={t.reader.side.close}
          className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5"
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <div ref={box} className="min-h-0 flex-1 overflow-auto p-4">
        {error ? (
          <p className="text-danger text-sm">{t.reader.loadError}</p>
        ) : !pdf || !size ? (
          <p className="text-text-muted text-sm">{t.common.loading}</p>
        ) : (
          <div className="relative mx-auto" style={{ width: w, height: h }} data-side-page={page}>
            <PdfPage
              key={`${side.docId}-${page}`}
              pdf={pdf}
              pageNumber={page}
              scale={scale}
              width={w}
              height={h}
              style={{ left: 0, top: 0 }}
              underlay={<AnnotationUnderlay docId={side.docId} page={page} />}
              overlay={(l: PageLayers) => (
                <PointerLayer
                  pageNumber={page}
                  docId={side.docId}
                  layers={l}
                  width={w}
                  height={h}
                />
              )}
            />
          </div>
        )}
      </div>
    </section>
  );
}
