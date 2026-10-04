import { boardNoteSpot, pointNotes, type Annotation } from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import {
  BookmarkPlus,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Columns2,
  FilePlus2,
  Link2,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { t } from '../../i18n';
import { queryClient } from '../../lib/queryClient';
import { Markdown } from '../chat/Markdown';
import { annotationsKey } from '../annotations/api';
import { useChat } from '../chat/store';
import { useReader } from '../reader/store';
import { flushBoard, newBoard, saveBoardInNote, unlinkBoard, useBoard } from './store';

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
      className={footerButton}
    >
      <CheckCheck size={14} aria-hidden />
      {t.board.check}
    </button>
  );
}

const footerButton =
  'hover:bg-surface-muted flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50';

/**
 * "Guardar en el PDF": keeps a copy of the board in a note on the page being read
 * (owner's choice: an editable copy inside a note), then offers to show it.
 */
function SaveToPdfButton() {
  const docId = useReader((s) => s.docId);
  // A reader is open (the reader store keeps its last document after leaving it).
  const reading = useBoard((s) => s.dockable);
  const hasDrawing = useBoard((s) => (s.scene?.elements.length ?? 0) > 0);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'saved'; page: number; id: string }
    | { kind: 'error' }
  >({ kind: 'idle' });
  useEffect(() => {
    if (state.kind !== 'saved' && state.kind !== 'error') return;
    const timer = setTimeout(() => setState({ kind: 'idle' }), 6000);
    return () => clearTimeout(timer);
  }, [state]);
  if (!docId || !reading || (!hasDrawing && state.kind === 'idle')) return null;
  if (state.kind === 'saved') {
    return (
      <span role="status" className="text-ok flex items-center gap-1 text-xs">
        {t.board.saved(state.page)}
        <button
          type="button"
          onClick={() => {
            useReader.getState().goTo(state.page);
            useReader.getState().setActiveAnnotation(state.id);
          }}
          className="text-text font-medium hover:underline"
        >
          {t.board.goToNote}
        </button>
      </span>
    );
  }
  if (state.kind === 'error') {
    return (
      <span role="alert" className="text-danger text-xs">
        {t.board.saveFailed}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={state.kind === 'busy'}
      title={t.board.saveToPdfHint}
      onClick={() => {
        const page = useReader.getState().currentPage;
        setState({ kind: 'busy' });
        // Top right corner of the page being read, below other notes there.
        const list = queryClient.getQueryData<Annotation[]>(annotationsKey(docId)) ?? [];
        saveBoardInNote(docId, page, boardNoteSpot(pointNotes(list, page)))
          .then((note) => setState(note ? { kind: 'saved', page, id: note.id } : { kind: 'idle' }))
          .catch(() => setState({ kind: 'error' }));
      }}
      className={footerButton}
    >
      <BookmarkPlus size={14} aria-hidden />
      {t.board.saveToPdf}
    </button>
  );
}

/** "Nueva pizarra": starts over on a blank board. */
function NewBoardButton() {
  const hasDrawing = useBoard((s) => (s.scene?.elements.length ?? 0) > 0);
  const running = useChat((s) => s.running);
  if (!hasDrawing) return null;
  return (
    <button
      type="button"
      disabled={running}
      onClick={() => void newBoard()}
      aria-label={t.board.newBoard}
      title={t.board.newBoard}
      className={iconButton}
    >
      <FilePlus2 size={16} aria-hidden />
    </button>
  );
}

/** Shown while the board is a note's board opened to keep working on it. */
function LinkedBanner() {
  const linked = useBoard((s) => s.linked);
  const docId = useReader((s) => s.docId);
  const reading = useBoard((s) => s.dockable);
  if (!linked) return null;
  return (
    <div
      className="border-border bg-surface-muted flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-xs"
      data-testid="board-linked"
    >
      <Link2 size={14} aria-hidden className="text-text-muted shrink-0" />
      <span className="min-w-0 flex-1">{t.board.linked(linked.page)}</span>
      {reading && docId === linked.documentId && (
        <button
          type="button"
          onClick={() => {
            useReader.getState().goTo(linked.page);
            useReader.getState().setActiveAnnotation(linked.annotationId);
          }}
          className="font-medium hover:underline"
        >
          {t.board.goToNote}
        </button>
      )}
      <button
        type="button"
        onClick={() => void unlinkBoard()}
        className="font-medium hover:underline"
      >
        {t.board.unlink}
      </button>
    </div>
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
      <LinkedBanner />
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
        <SaveToPdfButton />
        <span className="flex-1" />
        <NewBoardButton />
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
