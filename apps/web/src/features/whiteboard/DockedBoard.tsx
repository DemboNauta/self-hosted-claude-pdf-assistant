import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { t } from '../../i18n';
import { isDocked, useBoard } from './store';
import { WhiteboardPanel } from './WhiteboardPanel';

const landscape = () => window.matchMedia('(orientation: landscape)').matches;

/**
 * The reader's page area with the whiteboard next to it when "Abrir junto al PDF" is on:
 * side by side in landscape (board on the right), stacked in portrait (board on top),
 * with a grip to share the space. Registers the reader as a place the board can dock.
 */
export function ReaderWithBoard({ children }: { children: ReactNode }) {
  const docked = useBoard(isDocked);
  const size = useBoard((s) => s.dockSize);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    useBoard.getState().setDockable(true);
    return () => useBoard.getState().setDockable(false);
  }, []);

  const resizeTo = (e: ReactPointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    useBoard
      .getState()
      .setDockSize(landscape() ? (r.right - e.clientX) / r.width : (e.clientY - r.top) / r.height);
  };

  return (
    <div ref={box} className="relative flex min-w-0 flex-1 flex-col-reverse landscape:flex-row">
      {children}
      {docked && (
        <>
          <div
            role="separator"
            aria-label={t.board.resizeDock}
            aria-valuenow={Math.round(size * 100)}
            aria-valuemin={25}
            aria-valuemax={75}
            tabIndex={0}
            onPointerDown={(e) => {
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => dragging.current && resizeTo(e)}
            onPointerUp={() => (dragging.current = false)}
            onPointerCancel={() => (dragging.current = false)}
            onKeyDown={(e) => {
              const grow = landscape() ? 'ArrowLeft' : 'ArrowDown';
              const shrink = landscape() ? 'ArrowRight' : 'ArrowUp';
              if (e.key === grow) useBoard.getState().setDockSize(size + 0.05);
              if (e.key === shrink) useBoard.getState().setDockSize(size - 0.05);
            }}
            data-testid="board-dock-handle"
            className="bg-border hover:bg-text-muted focus-visible:bg-text-muted flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center landscape:h-auto landscape:w-3 landscape:cursor-col-resize"
          >
            <span className="bg-surface h-1 w-10 rounded-full landscape:h-10 landscape:w-1" />
          </div>
          <section
            aria-label={t.board.title}
            className="flex min-h-0 min-w-0 shrink-0 flex-col"
            style={{ flexBasis: `${size * 100}%` }}
            data-testid="board-dock"
          >
            <WhiteboardPanel docked />
          </section>
        </>
      )}
    </div>
  );
}
