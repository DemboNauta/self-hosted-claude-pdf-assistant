import type { DocumentDetail } from '@pdfclaudeassistant/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { MessageSquare } from 'lucide-react';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { ChatDock, useChatDock } from '../chat/ChatDock';
import { useChat } from '../chat/store';
import { libraryKey } from '../library/api';
import { openPdf, type PDFDocumentProxy } from './pdf';
import { PdfViewer, type ReadingPositionUpdate } from './PdfViewer';
import { PointerLayer } from './PointerLayer';
import { ReaderToolbar } from './ReaderToolbar';
import { SelectionMenu } from './SelectionMenu';
import { OutlinePanel, SearchPanel, ThumbnailsPanel } from './SidePanels';
import { useReader } from './store';

/** Loads the PDF with PDF.js; the proxy is destroyed when the document changes. */
function usePdf(docId: string | undefined, enabled: boolean) {
  const [state, setState] = useState<{ pdf: PDFDocumentProxy | null; error: boolean }>({
    pdf: null,
    error: false,
  });
  useEffect(() => {
    if (!docId || !enabled) return;
    const task = openPdf(docId);
    task.promise.then(
      (pdf) => setState({ pdf, error: false }),
      () => setState({ pdf: null, error: true }),
    );
    return () => {
      setState({ pdf: null, error: false });
      void task.destroy();
    };
  }, [docId, enabled]);
  return state;
}

/** Reader: PDF viewer with thumbnails, outline and search (F-VIS-01/02, F-LIB-04). */
export function ReaderPage() {
  const { documentId } = useParams();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const chatOpen = useChatDock((s) => s.open || s.sheet !== 'closed');
  const detail = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api<DocumentDetail>(`/documents/${documentId}`),
    // The saved position is read once; refetching would not move the viewer anyway.
    staleTime: Infinity,
  });
  const ready = detail.data?.status === 'ready';
  const { pdf, error } = usePdf(documentId, ready);
  const panel = useReader((s) => s.panel);

  useEffect(() => {
    if (!detail.data) return;
    useReader.getState().open(detail.data.id, detail.data.pageSizes.length);
    void useChat.getState().openDocument(detail.data.id);
  }, [detail.data]);

  // Arriving from a citation in another document: show that page and flash the quote.
  const citedPage = Number(params.get('page')) || null;
  const citedQuote = params.get('q') ?? undefined;
  useEffect(() => {
    if (pdf && citedPage) useReader.getState().goTo(citedPage, citedQuote);
  }, [pdf, citedPage, citedQuote]);

  const savePosition = useCallback(
    (pos: ReadingPositionUpdate) => {
      void fetch(`/api/documents/${documentId}/position`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pos),
        // Lets the last save finish when the reader is closed.
        keepalive: true,
      }).then(() => qc.invalidateQueries({ queryKey: libraryKey }));
    },
    [documentId, qc],
  );

  if (detail.isPending) return <p className="text-text-muted p-6">{t.common.loading}</p>;
  if (detail.isError) return <p className="text-danger p-6">{t.common.error}</p>;
  const doc = detail.data;
  const backTo = doc.topicId ? `/library/t/${doc.topicId}` : '/library';

  return (
    <div className="flex h-full flex-col">
      <ReaderToolbar
        title={doc.title}
        backTo={backTo}
        trailing={
          <button
            type="button"
            onClick={() => useChatDock.getState().toggle()}
            aria-label={t.chat.open}
            title={t.chat.open}
            aria-pressed={chatOpen}
            className="text-text-muted hover:text-text hover:bg-surface-muted aria-pressed:bg-surface-muted aria-pressed:text-text ml-1 rounded-md p-2"
          >
            <MessageSquare size={18} aria-hidden />
          </button>
        }
      />
      <div className="relative flex min-h-0 flex-1">
        {pdf && panel === 'thumbnails' && <ThumbnailsPanel pdf={pdf} pageSizes={doc.pageSizes} />}
        {panel === 'outline' && <OutlinePanel outline={doc.outline} />}
        {panel === 'search' && <SearchPanel docId={doc.id} />}
        <div className="min-w-0 flex-1">
          {!ready ? (
            <p className="text-text-muted p-6">{t.reader.notReady}</p>
          ) : error ? (
            <p className="text-danger p-6">{t.reader.loadError}</p>
          ) : !pdf ? (
            <p className="text-text-muted p-6">{t.common.loading}</p>
          ) : (
            <PdfViewer
              pdf={pdf}
              pageSizes={doc.pageSizes}
              initialPage={citedPage ?? doc.lastPage}
              initialScroll={citedPage ? 0 : doc.lastScroll}
              onPosition={savePosition}
              onScroller={setScroller}
              overlay={(page, layers, size) => (
                <PointerLayer pageNumber={page} docId={doc.id} layers={layers} {...size} />
              )}
            />
          )}
        </div>
        <ChatDock />
      </div>
      <SelectionMenu root={scroller} />
    </div>
  );
}
