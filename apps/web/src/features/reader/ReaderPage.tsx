import type { DocumentDetail } from '@pdfclaudeassistant/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useReadingTimer } from './readingTimer';
import { useParams, useSearchParams } from 'react-router';
import { MessageSquare, PenTool } from 'lucide-react';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { AnnotationOverlay, AnnotationUnderlay } from '../annotations/AnnotationLayer';
import { AnnotationsPanel } from '../annotations/AnnotationsPanel';
import { AnnotationTools, useUndoShortcuts } from '../annotations/AnnotationTools';
import {
  installAnnotationIntegrations,
  useSelectionAnnotationActions,
} from '../annotations/integrations';
import { ChatDock, useChatDock } from '../chat/ChatDock';
import { DiagramsPanel } from '../diagrams/DiagramsPanel';
import { MemoryPanel } from '../memory/MemoryPanel';
import { FlashcardDialog, flashcardAction } from '../review/FlashcardDialog';
import { useChat } from '../chat/store';
import { libraryKey } from '../library/api';
import { openPdf, type PDFDocumentProxy } from './pdf';
import { PdfViewer, type ReadingPositionUpdate } from './PdfViewer';
import { PointerLayer } from './PointerLayer';
import { ReaderToolbar } from './ReaderToolbar';
import { SelectionMenu } from './SelectionMenu';
import { ShortcutsHelp, useReaderShortcuts } from './shortcuts';
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

installAnnotationIntegrations();

/** Reader: PDF viewer with side panels, annotations and the chat with Claude. */
export function ReaderPage() {
  const { documentId } = useParams();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const chatOpen = useChatDock((s) => s.open || s.sheet !== 'closed');
  const [showTools, setShowTools] = useState(false);
  const selectionActions = useSelectionAnnotationActions(documentId ?? '');
  useUndoShortcuts();
  const shortcuts = useReaderShortcuts(documentId ?? '', scroller);
  const detail = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api<DocumentDetail>(`/documents/${documentId}`),
    // The saved position is read once; refetching would not move the viewer anyway.
    staleTime: Infinity,
    // ...but drop it on leaving, so reopening the document reads the position saved since.
    gcTime: 0,
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

  const reading = useReadingTimer();
  const lastPos = useRef<ReadingPositionUpdate | null>(null);
  const savePosition = useCallback(
    (update: ReadingPositionUpdate) => {
      lastPos.current = update;
      const pos = { ...update, ...reading.take() };
      void fetch(`/api/documents/${documentId}/position`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pos),
        // Lets the last save finish when the reader is closed.
        keepalive: true,
      }).then(() => qc.invalidateQueries({ queryKey: libraryKey }));
    },
    [documentId, qc, reading],
  );

  // Flush reading time every minute even without scrolling (long pages, formulas…).
  useEffect(() => {
    const timer = setInterval(() => {
      if (lastPos.current && reading.pending() >= 30)
        savePosition({ ...lastPos.current, viewed: [] });
    }, 60_000);
    return () => clearInterval(timer);
  }, [savePosition, reading]);

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
          <>
            <button
              type="button"
              onClick={() => {
                if (showTools) useReader.getState().setTool('select');
                setShowTools(!showTools);
              }}
              aria-label={t.annotations.tools.label}
              title={t.annotations.tools.label}
              aria-pressed={showTools}
              className="text-text-muted hover:text-text hover:bg-surface-muted aria-pressed:bg-surface-muted aria-pressed:text-text ml-1 rounded-md p-2"
            >
              <PenTool size={18} aria-hidden />
            </button>
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
          </>
        }
      />
      <div className="relative flex min-h-0 flex-1">
        {pdf && panel === 'thumbnails' && <ThumbnailsPanel pdf={pdf} pageSizes={doc.pageSizes} />}
        {panel === 'outline' && <OutlinePanel outline={doc.outline} />}
        {panel === 'search' && <SearchPanel docId={doc.id} />}
        {panel === 'annotations' && <AnnotationsPanel docId={doc.id} />}
        {panel === 'memory' && <MemoryPanel docId={doc.id} />}
        {panel === 'diagrams' && <DiagramsPanel docId={doc.id} />}
        <div className="relative min-w-0 flex-1">
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
              underlay={(page) => <AnnotationUnderlay docId={doc.id} page={page} />}
              overlay={(page, layers, size) => (
                <>
                  <AnnotationOverlay docId={doc.id} page={page} layers={layers} {...size} />
                  <PointerLayer pageNumber={page} docId={doc.id} layers={layers} {...size} />
                </>
              )}
            />
          )}
          {showTools && pdf && <AnnotationTools />}
        </div>
        <ChatDock />
      </div>
      <SelectionMenu root={scroller} extra={[flashcardAction(doc.id), ...selectionActions]} />
      <FlashcardDialog />
      {shortcuts.help && <ShortcutsHelp onClose={shortcuts.closeHelp} />}
    </div>
  );
}
