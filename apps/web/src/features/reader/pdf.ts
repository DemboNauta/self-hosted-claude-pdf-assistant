import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Opens a library PDF with PDF.js; data files come from the server (same pdfjs-dist version). */
export function openPdf(docId: string) {
  return getDocument({
    url: `/api/documents/${docId}/file`,
    withCredentials: true,
    cMapUrl: '/api/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/api/pdfjs/standard_fonts/',
    wasmUrl: '/api/pdfjs/wasm/',
    iccUrl: '/api/pdfjs/iccs/',
  });
}

export type { PDFDocumentProxy };

/** Largest canvas we render, in pixels (mobile browsers refuse bigger ones). */
export const MAX_CANVAS_PIXELS = 16_777_216;
