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
const MIN_WIDTH = 300;
const MAX_WIDTH = 720;

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
  setOpen: (open: boolean) => void;
  setSheet: (sheet: SheetState) => void;
  setWidth: (width: number) => void;
  /** Shows the chat whatever the screen size (selection menu, toolbar button). */
  show: () => void;
  toggle: () => void;
}

export const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;

export const useChatDock = create<DockState>((set, get) => ({
  open: read(OPEN_KEY) !== '0',
  sheet: 'closed',
  width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(read(WIDTH_KEY)) || 400)),
  setOpen: (open) => {
    write(OPEN_KEY, open ? '1' : '0');
    set({ open });
  },
  setSheet: (sheet) => set({ sheet }),
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
    const mq = window.matchMedia('(min-width: 1024px)');
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
      className="hover:bg-border focus-visible:bg-border absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
    />
  );
}

/** Where the chat lives: right panel on desktop, bottom sheet on phones and tablets. */
export function ChatDock() {
  const desktop = useIsDesktop();
  const { open, sheet, width, setOpen, setSheet } = useChatDock();

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
        sheet === 'full' ? 'top-0' : 'h-[55%]',
      )}
      data-testid="chat-sheet"
    >
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
