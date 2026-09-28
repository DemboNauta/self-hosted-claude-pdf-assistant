import clsx from 'clsx';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { create } from 'zustand';
import { t } from '../../i18n';
import { useVoice } from '../voice/store';
import { useEndVoiceOnLeave, VoiceBar } from '../voice/VoiceBar';
import { ChatPanel } from './ChatPanel';
import { CITATION_EVENT } from './CitationChip';

const WIDTH_KEY = 'pca.chat.width';
const OPEN_KEY = 'pca.chat.open';
const SHEET_KEY = 'pca.chat.sheet';
const MIN_WIDTH = 300;
const MAX_WIDTH = 720;
/** Bottom sheet height as a fraction of the reader (dragged by its handle). */
const MIN_SHEET = 0.2;
const MAX_SHEET = 0.9;

/**
 * Side panel on desktops and on tablets held horizontally; bottom sheet on phones and
 * tablets held vertically.
 */
const SIDE_QUERY = '(min-width: 1024px), (min-width: 768px) and (orientation: landscape)';

/** Mobile bottom sheet heights (SPEC §4: half / full). */
export type SheetState = 'closed' | 'half' | 'full';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

interface DockState {
  /** Desktop: side panel visible. */
  open: boolean;
  /** Mobile: bottom sheet height. */
  sheet: SheetState;
  width: number;
  /** Height of the half-open bottom sheet (fraction of the reader). */
  sheetHeight: number;
  setOpen: (open: boolean) => void;
  setSheet: (sheet: SheetState) => void;
  setWidth: (width: number) => void;
  setSheetHeight: (fraction: number) => void;
  /** Shows the chat whatever the screen size (selection menu, toolbar button). */
  show: () => void;
  toggle: () => void;
}

export const isDesktop = () => window.matchMedia(SIDE_QUERY).matches;

const clampSheet = (f: number) => Math.min(MAX_SHEET, Math.max(MIN_SHEET, f));

export const useChatDock = create<DockState>((set, get) => ({
  open: read(OPEN_KEY) !== '0',
  sheet: 'closed',
  width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(read(WIDTH_KEY)) || 400)),
  sheetHeight: clampSheet(Number(read(SHEET_KEY)) || 0.55),
  setOpen: (open) => {
    write(OPEN_KEY, open ? '1' : '0');
    set({ open });
  },
  setSheet: (sheet) => set({ sheet }),
  setSheetHeight: (fraction) => {
    const f = clampSheet(fraction);
    write(SHEET_KEY, f.toFixed(3));
    set({ sheetHeight: f });
  },
  setWidth: (width) => {
    const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
    write(WIDTH_KEY, String(Math.round(w)));
    set({ width: w });
  },
  show: () => {
    if (isDesktop()) get().setOpen(true);
    else if (get().sheet === 'closed') set({ sheet: 'half' });
  },
  toggle: () => {
    if (isDesktop()) get().setOpen(!get().open);
    else set({ sheet: get().sheet === 'closed' ? 'half' : 'closed' });
  },
}));

function useIsDesktop() {
  const [desktop, setDesktop] = useState(isDesktop);
  useEffect(() => {
    const mq = window.matchMedia(SIDE_QUERY);
    const on = () => setDesktop(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return desktop;
}

/** Drag handle on the panel's left edge (SPEC §4: resizable right panel). */
function ResizeHandle() {
  const setWidth = useChatDock((s) => s.setWidth);
  const width = useChatDock((s) => s.width);
  const start = useRef<{ x: number; w: number } | null>(null);
  const onDown = (e: ReactPointerEvent) => {
    start.current = { x: e.clientX, w: useChatDock.getState().width };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    if (start.current) setWidth(start.current.w + (start.current.x - e.clientX));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t.chat.resize}
      aria-valuenow={Math.round(width)}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={() => (start.current = null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setWidth(width + 24);
        if (e.key === 'ArrowRight') setWidth(width - 24);
      }}
      className="group hover:bg-border focus-visible:bg-border absolute inset-y-0 -left-1.5 z-10 flex w-3 cursor-col-resize touch-none items-center justify-center"
    >
      {/* A visible grip for fingers and pens (there is no hover on touch screens). */}
      <span className="bg-border group-hover:bg-text-muted h-10 w-1 rounded-full pointer-fine:hidden" />
    </div>
  );
}

/**
 * Grip at the top of the bottom sheet: drag it to any height; dragging near the top opens
 * it full, near the bottom closes it.
 */
function SheetHandle() {
  const { sheet, sheetHeight, setSheet, setSheetHeight } = useChatDock();
  const drag = useRef<{ box: DOMRect; fraction: number } | null>(null);
  const fractionAt = (y: number, box: DOMRect) => (box.bottom - y) / box.height;
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const parent = e.currentTarget.closest('[data-testid="chat-sheet"]')?.parentElement;
    if (!parent) return;
    const box = parent.getBoundingClientRect();
    drag.current = { box, fraction: fractionAt(e.clientY, box) };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.fraction = fractionAt(e.clientY, d.box);
    if (sheet === 'full') setSheet('half');
    setSheetHeight(d.fraction);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.fraction > 0.95) setSheet('full');
    else if (d.fraction < 0.12) setSheet('closed');
  };
  const current = sheet === 'full' ? 1 : sheetHeight;
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t.chat.resizeSheet}
      aria-valuenow={Math.round(current * 100)}
      aria-valuemin={Math.round(MIN_SHEET * 100)}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') setSheetHeight(current + 0.05);
        if (e.key === 'ArrowDown') setSheetHeight(current - 0.05);
      }}
      data-testid="chat-sheet-handle"
      className="bg-surface flex h-5 shrink-0 cursor-row-resize touch-none items-center justify-center"
    >
      <span className="bg-border h-1 w-10 rounded-full" />
    </div>
  );
}

/**
 * Where the chat lives: resizable right panel on desktop and landscape tablets, bottom
 * sheet (height dragged by its grip) on phones and portrait tablets.
 */
export function ChatDock() {
  const desktop = useIsDesktop();
  const { open, sheet, width, sheetHeight, setOpen, setSheet } = useChatDock();

  useEndVoiceOnLeave();
  const voiceActive = useVoice((s) => s.active);

  // After a citation jump on mobile, lower the sheet so the page is visible.
  useEffect(() => {
    const onCite = () => {
      if (!isDesktop() && useChatDock.getState().sheet === 'full') setSheet('half');
    };
    window.addEventListener(CITATION_EVENT, onCite);
    return () => window.removeEventListener(CITATION_EVENT, onCite);
  }, [setSheet]);

  if (desktop) {
    if (!open) return voiceActive ? <FloatingVoice /> : null;
    return (
      <div className="border-border relative shrink-0 border-l" style={{ width }}>
        <ResizeHandle />
        <ChatPanel
          headerActions={
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t.chat.close}
              title={t.chat.close}
              className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5"
            >
              <X size={16} aria-hidden />
            </button>
          }
        />
      </div>
    );
  }

  if (sheet === 'closed') return voiceActive ? <FloatingVoice /> : null;
  return (
    <div
      className={clsx(
        'border-border absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-2xl border-t shadow-[0_-8px_24px_rgba(0,0,0,0.12)]',
        sheet === 'full' && 'top-0',
      )}
      style={sheet === 'full' ? undefined : { height: `${sheetHeight * 100}%` }}
      data-testid="chat-sheet"
    >
      <SheetHandle />
      <ChatPanel
        headerActions={
          <>
            <button
              type="button"
              onClick={() => setSheet(sheet === 'full' ? 'half' : 'full')}
              aria-label={sheet === 'full' ? t.chat.collapse : t.chat.expand}
              className="text-text-muted hover:text-text rounded-md p-1.5"
            >
              {sheet === 'full' ? (
                <ChevronDown size={16} aria-hidden />
              ) : (
                <ChevronUp size={16} aria-hidden />
              )}
            </button>
            <button
              type="button"
              onClick={() => setSheet('closed')}
              aria-label={t.chat.close}
              className="text-text-muted hover:text-text rounded-md p-1.5"
            >
              <X size={16} aria-hidden />
            </button>
          </>
        }
      />
    </div>
  );
}

/** Voice mode keeps going with the chat closed, so the whole page stays visible. */
function FloatingVoice() {
  return (
    <div className="bg-surface absolute inset-x-3 bottom-3 z-30 rounded-lg shadow-lg lg:left-auto lg:w-96">
      <VoiceBar />
    </div>
  );
}
