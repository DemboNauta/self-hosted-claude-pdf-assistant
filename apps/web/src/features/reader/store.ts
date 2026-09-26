import { create } from 'zustand';

export type ZoomMode = 'fit-width' | 'fit-page' | 'custom';
export type SidePanel = 'thumbnails' | 'outline' | 'search' | 'annotations' | 'memory' | null;

/** Pointer tool on the page: normal reading/selection, freehand pen, eraser or note pin. */
export type AnnotationTool = 'select' | 'draw' | 'erase' | 'note';

export interface AnnotationFilter {
  visible: boolean;
  mine: boolean;
  claude: boolean;
  /** Palette keys hidden by the filter. */
  hiddenColors: string[];
}

/** A request to show a page, optionally flashing a quote on it (F-VIS-03). */
export interface NavRequest {
  page: number;
  quote?: string;
  /** Changes on every request so asking twice for the same page still scrolls. */
  nonce: number;
}

interface ReaderState {
  docId: string | null;
  pageCount: number;
  currentPage: number;
  zoomMode: ZoomMode;
  /** Effective scale (CSS px per PDF point). */
  scale: number;
  panel: SidePanel;
  nav: NavRequest | null;
  /** Quote flashed after a citation jump; cleared after a few seconds. */
  flash: { page: number; quote: string; nonce: number } | null;
  /** Terms highlighted on every page while the search panel has a query. */
  searchTerms: string | null;
  tool: AnnotationTool;
  pen: { color: string; width: number };
  filter: AnnotationFilter;
  /** Annotation whose popover is open. */
  activeAnnotation: string | null;

  open: (docId: string, pageCount: number) => void;
  setCurrentPage: (page: number) => void;
  setZoom: (mode: ZoomMode, scale?: number) => void;
  setScale: (scale: number) => void;
  togglePanel: (panel: Exclude<SidePanel, null>) => void;
  closePanel: () => void;
  goTo: (page: number, quote?: string) => void;
  setSearchTerms: (terms: string | null) => void;
  setTool: (tool: AnnotationTool) => void;
  setPen: (pen: Partial<{ color: string; width: number }>) => void;
  setFilter: (filter: Partial<AnnotationFilter>) => void;
  setActiveAnnotation: (id: string | null) => void;
}

let nonce = 0;

export const useReader = create<ReaderState>((set, get) => ({
  docId: null,
  pageCount: 0,
  currentPage: 1,
  zoomMode: 'fit-width',
  scale: 1,
  panel: null,
  nav: null,
  flash: null,
  searchTerms: null,
  tool: 'select',
  pen: { color: '#1f6feb', width: 0.003 },
  filter: { visible: true, mine: true, claude: true, hiddenColors: [] },
  activeAnnotation: null,

  open: (docId, pageCount) =>
    set({
      docId,
      pageCount,
      currentPage: 1,
      nav: null,
      flash: null,
      searchTerms: null,
      tool: 'select',
      activeAnnotation: null,
    }),
  setCurrentPage: (currentPage) => {
    if (get().currentPage !== currentPage) set({ currentPage });
  },
  setZoom: (zoomMode, scale) => set(scale ? { zoomMode, scale } : { zoomMode }),
  setScale: (scale) => set({ scale }),
  togglePanel: (panel) => set({ panel: get().panel === panel ? null : panel }),
  closePanel: () => set({ panel: null }),
  goTo: (page, quote) => {
    const { pageCount } = get();
    const target = Math.min(Math.max(1, Math.round(page)), Math.max(1, pageCount));
    nonce++;
    set({
      nav: { page: target, quote, nonce },
      flash: quote ? { page: target, quote, nonce } : get().flash,
    });
  },
  setSearchTerms: (searchTerms) => set({ searchTerms }),
  setTool: (tool) => set({ tool, activeAnnotation: null }),
  setPen: (pen) => set({ pen: { ...get().pen, ...pen } }),
  setFilter: (filter) => set({ filter: { ...get().filter, ...filter } }),
  setActiveAnnotation: (activeAnnotation) => set({ activeAnnotation }),
}));

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 5;
