import { useEffect, useState } from 'react';
import { openPdf, type PDFDocumentProxy } from './pdf';

/** Loads a library PDF with PDF.js; the proxy is destroyed when the document changes. */
export function usePdf(docId: string | undefined, enabled: boolean) {
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
