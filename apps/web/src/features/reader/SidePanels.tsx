import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type OutlineEntry,
  type PageSize,
  type SearchHit,
} from '@pdfclaudeassistant/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import type { PDFDocumentProxy } from './pdf';
import { useReader } from './store';

const THUMB_WIDTH = 120;

/** Side panel shell: docked on desktop, full-screen sheet on small screens. */
export function SidePanelFrame({ title, children }: { title: string; children: ReactNode }) {
  const close = useReader((s) => s.closePanel);
  return (
    <aside
      aria-label={title}
      className="border-border bg-surface absolute inset-0 z-20 flex flex-col md:static md:w-72 md:shrink-0 md:border-r"
    >
      <div className="border-border flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-medium">{title}</h2>
        <button
          type="button"
          onClick={close}
          aria-label={t.reader.closePanel}
          className="text-text-muted hover:text-text rounded p-1"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

/** Closes the panel after picking something on small screens, where it covers the page. */
function goAndMaybeClose(page: number, quote?: string) {
  useReader.getState().goTo(page, quote);
  if (!window.matchMedia('(min-width: 768px)').matches) useReader.getState().closePanel();
}

// ---- thumbnails ---------------------------------------------------------

function Thumbnail({ pdf, page, size }: { pdf: PDFDocumentProxy; page: number; size: PageSize }) {
  const box = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const current = useReader((s) => s.currentPage === page);
  const height = (THUMB_WIDTH * size.height) / size.width;

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setVisible(true), {
      rootMargin: '400px 0px',
    });
    io.observe(box.current!);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      const p = await pdf.getPage(page);
      if (cancelled) return;
      const viewport = p.getViewport({
        scale: (THUMB_WIDTH * 2) / p.getViewport({ scale: 1 }).width,
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.className = 'size-full';
      task = p.render({ canvas, viewport });
      await task.promise;
      if (!cancelled) box.current?.querySelector('[data-canvas]')?.replaceChildren(canvas);
    })().catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, pdf, page]);

  useEffect(() => {
    if (current) box.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <button
      ref={box}
      type="button"
      onClick={() => goAndMaybeClose(page)}
      aria-label={t.reader.pageLabel(page)}
      aria-current={current ? 'page' : undefined}
      className="flex flex-col items-center gap-1 rounded-md p-1.5"
    >
      <span
        data-canvas
        className={clsx(
          'block overflow-hidden bg-white ring-1',
          current ? 'ring-text ring-2' : 'ring-black/10',
        )}
        style={{ width: THUMB_WIDTH, height }}
      />
      <span className={clsx('text-xs tabular-nums', current ? 'font-medium' : 'text-text-muted')}>
        {page}
      </span>
    </button>
  );
}

export function ThumbnailsPanel({
  pdf,
  pageSizes,
}: {
  pdf: PDFDocumentProxy;
  pageSizes: PageSize[];
}) {
  return (
    <SidePanelFrame title={t.reader.thumbnails}>
      <div className="flex flex-col items-center py-2">
        {pageSizes.map((size, i) => (
          <Thumbnail key={i} pdf={pdf} page={i + 1} size={size} />
        ))}
      </div>
    </SidePanelFrame>
  );
}

// ---- outline ------------------------------------------------------------

function OutlineList({ items, depth }: { items: OutlineEntry[]; depth: number }) {
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>
          <button
            type="button"
            disabled={item.page === null}
            onClick={() => item.page && goAndMaybeClose(item.page)}
            className="hover:bg-surface-muted flex w-full items-baseline gap-2 py-1.5 pr-3 text-left text-sm disabled:opacity-60"
            style={{ paddingLeft: 12 + depth * 14 }}
          >
            <span className="min-w-0 flex-1">{item.title}</span>
            {item.page && <span className="text-text-muted text-xs tabular-nums">{item.page}</span>}
          </button>
          {item.items.length > 0 && <OutlineList items={item.items} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export function OutlinePanel({ outline }: { outline: OutlineEntry[] }) {
  return (
    <SidePanelFrame title={t.reader.outline}>
      {outline.length === 0 ? (
        <p className="text-text-muted p-3 text-sm">{t.reader.noOutline}</p>
      ) : (
        <nav aria-label={t.reader.outline} className="py-1">
          <OutlineList items={outline} depth={0} />
        </nav>
      )}
    </SidePanelFrame>
  );
}

// ---- search -------------------------------------------------------------

/** Renders an FTS snippet, turning the match markers into <mark>. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(
    new RegExp(`(${SEARCH_MARK_START}[^${SEARCH_MARK_END}]*${SEARCH_MARK_END})`),
  );
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith(SEARCH_MARK_START) ? (
          <mark key={i} className="rounded-sm bg-yellow-300/60 text-inherit">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function SearchPanel({ docId }: { docId: string }) {
  const [input, setInput] = useState(useReader.getState().searchTerms ?? '');
  const [query, setQuery] = useState(input.trim());
  const setSearchTerms = useReader((s) => s.setSearchTerms);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 250);
    return () => clearTimeout(timer);
  }, [input]);
  useEffect(() => {
    setSearchTerms(query || null);
  }, [query, setSearchTerms]);
  // Leaving the panel clears the on-page highlights.
  useEffect(() => () => setSearchTerms(null), [setSearchTerms]);

  const results = useQuery({
    queryKey: ['doc-search', docId, query],
    queryFn: () =>
      api<SearchHit[]>(`/search?scope=doc&id=${docId}&limit=200&q=${encodeURIComponent(query)}`),
    enabled: query.length > 0,
  });

  return (
    <SidePanelFrame title={t.reader.search}>
      <div className="border-border sticky top-0 border-b bg-inherit p-3">
        <input
          type="search"
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t.reader.searchPlaceholder}
          aria-label={t.reader.search}
          className="border-border bg-bg w-full rounded-lg border px-3 py-2 text-base"
        />
        {results.data && (
          <p className="text-text-muted mt-2 text-xs" role="status">
            {results.data.length ? t.reader.resultsCount(results.data.length) : t.reader.noResults}
          </p>
        )}
      </div>
      <ul>
        {results.data?.map((hit) => (
          <li key={hit.page}>
            <button
              type="button"
              onClick={() => goAndMaybeClose(hit.page)}
              className="hover:bg-surface-muted w-full px-3 py-2 text-left"
            >
              <span className="text-text-muted block text-xs">{t.reader.pageLabel(hit.page)}</span>
              <span className="line-clamp-3 text-sm">
                <Snippet text={hit.snippet} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </SidePanelFrame>
  );
}
