import clsx from 'clsx';
import {
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Columns2,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { t } from '../../i18n';
import { Markdown } from '../chat/Markdown';
import { useChat } from '../chat/store';
import { flushBoard, useBoard } from './store';

const BoardCanvas = lazy(() => import('./BoardCanvas'));

/** The answer being given (or the last one), so the explanation stays readable. */
function LatestAnswer() {
  const message = useChat((s) => s.messages.findLast((m) => m.role === 'assistant'));
  const [open, setOpen] = useState(true);
  if (!message?.content) return null;
  return (
    <div className="border-border bg-surface border-t" data-testid="board-answer">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="text-text-muted hover:text-text flex w-full items-center gap-1 px-3 py-1 text-xs"
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronUp size={12} aria-hidden />}
        {t.board.answer}
      </button>
      {open && (
        <div className="max-h-[30vh] overflow-y-auto px-3 pb-2 text-sm">
          <Markdown
            text={message.content}
            streaming={message.status === 'streaming'}
            messageId={message.id}
          />
        </div>
      )}
    </div>
  );
}

/** "Revisar mi pizarra": asks Claude to look at what the student drew and correct it. */
function CheckButton() {
  const running = useChat((s) => s.running);
  const hasDrawing = useBoard((s) => (s.scene?.elements.length ?? 0) > 0);
  if (!hasDrawing) return null;
  return (
    <button
      type="button"
      disabled={running}
      onClick={() => {
        useBoard.getState().setExpanded(false);
        void flushBoard().then(() => useChat.getState().send(t.board.checkPrompt));
      }}
      className="hover:bg-surface-muted flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50"
    >
      <CheckCheck size={14} aria-hidden />
      {t.board.check}
    </button>
  );
}

/** In the chat's board tab while the board is open next to the PDF. */
export function DockedNotice() {
  return (
    <div className="text-text-muted flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
      <p>{t.board.docked}</p>
      <button
        type="button"
        onClick={() => {
          useBoard.getState().setDocked(false);
          useBoard.getState().setView('board');
        }}
        className="border-border hover:bg-surface-muted text-text flex items-center gap-1.5 rounded-md border px-3 py-1.5"
      >
        <PanelRightClose size={16} aria-hidden />
        {t.board.undock}
      </button>
    </div>
  );
}

const iconButton = 'text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5';

/**
 * The whiteboard (visual interaction, block 2): the hand-drawn board Claude explains on
 * and the student can draw on, with the current answer below. It lives in the chat's
 * board tab or, `docked`, next to the PDF ("Abrir junto al PDF"); "Ampliar" shows it over
 * the whole screen.
 */
export function WhiteboardPanel({ docked = false }: { docked?: boolean }) {
  const expanded = useBoard((s) => s.expanded);
  const setExpanded = useBoard((s) => s.setExpanded);
  const dockable = useBoard((s) => s.dockable);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, setExpanded]);

  return (
    <div
      className={clsx(
        'bg-surface flex min-h-0 flex-col',
        expanded ? 'fixed inset-0 z-50' : 'relative flex-1',
      )}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded || undefined}
      aria-label={expanded ? t.board.title : undefined}
    >
      <div className="relative min-h-0 flex-1">
        <Suspense
          fallback={
            <p className="text-text-muted flex h-full items-center justify-center gap-2 text-sm">
              <Loader2 size={14} aria-hidden className="animate-spin" />
              {t.board.loading}
            </p>
          }
        >
          <BoardCanvas />
        </Suspense>
      </div>
      <div className="border-border flex items-center gap-2 border-t px-2 py-1">
        <CheckButton />
        <span className="flex-1" />
        {docked ? (
          <button
            type="button"
            onClick={() => {
              useBoard.getState().setDocked(false);
              useBoard.getState().setView('board');
            }}
            aria-label={t.board.undock}
            title={t.board.undock}
            className={iconButton}
          >
            <PanelRightClose size={16} aria-hidden />
          </button>
        ) : (
          dockable &&
          !expanded && (
            <button
              type="button"
              onClick={() => useBoard.getState().setDocked(true)}
              aria-label={t.board.dock}
              title={t.board.dock}
              className={iconButton}
            >
              <Columns2 size={16} aria-hidden />
            </button>
          )
        )}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? t.board.shrink : t.board.expand}
          title={expanded ? t.board.shrink : t.board.expand}
          className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5"
        >
          {expanded ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
        </button>
      </div>
      <LatestAnswer />
    </div>
  );
}
