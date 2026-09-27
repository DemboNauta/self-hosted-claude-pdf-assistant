import clsx from 'clsx';
import { ChevronDown, ChevronUp, Loader2, Maximize2, Minimize2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { t } from '../../i18n';
import { Markdown } from '../chat/Markdown';
import { useChat } from '../chat/store';
import { useBoard } from './store';

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

/**
 * The whiteboard tab of the chat panel (visual interaction, block 2): the hand-drawn
 * board Claude explains on and the student can draw on, with the current answer below.
 * "Ampliar" shows it over the whole screen.
 */
export function WhiteboardPanel() {
  const expanded = useBoard((s) => s.expanded);
  const setExpanded = useBoard((s) => s.setExpanded);

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
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? t.board.shrink : t.board.expand}
          title={expanded ? t.board.shrink : t.board.expand}
          className="bg-surface border-border hover:bg-surface-muted absolute right-2 bottom-2 z-10 rounded-md border p-1.5 shadow-sm"
        >
          {expanded ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
        </button>
      </div>
      <LatestAnswer />
    </div>
  );
}
