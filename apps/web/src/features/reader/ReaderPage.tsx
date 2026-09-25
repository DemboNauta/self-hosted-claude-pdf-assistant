import type { DocumentDetail } from '@pdfclaudeassistant/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { libraryKey } from '../library/api';
import { openPdf, type PDFDocumentProxy } from './pdf';
import { PdfViewer, type ReadingPositionUpdate } from './PdfViewer';
import { ReaderToolbar } from './ReaderToolbar';
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
  const qc = useQueryClient();
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
    if (detail.data) useReader.getState().open(detail.data.id, detail.data.pageSizes.length);
  }, [detail.data]);

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
      <ReaderToolbar title={doc.title} backTo={backTo} />
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
              initialPage={doc.lastPage}
              initialScroll={doc.lastScroll}
              onPosition={savePosition}
            />
          )}
        </div>
      </div>
    </div>
  );
}
