import type { TextSelection } from '@pdfclaudeassistant/shared';
import { HelpCircle, Lightbulb, ListTree, MessageSquare, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { useChatDock } from '../chat/ChatDock';
import { useChat } from '../chat/store';

interface Current {
  selection: TextSelection;
  /** Selection box in viewport coordinates. */
  rect: DOMRect;
}

const MENU_GAP = 8;

/** Reads the current text-layer selection inside `root`, if any. */
function readSelection(root: HTMLElement): Current | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const start = range.startContainer.parentElement;
  if (!start || !root.contains(start) || !start.closest('.textLayer')) return null;
  const pageEl = start.closest<HTMLElement>('[data-page]');
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (!pageEl || text.length < 2) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { selection: { page: Number(pageEl.dataset.page), text: text.slice(0, 8000) }, rect };
}

export interface SelectionAction {
  id: string;
  label: string;
  icon: LucideIcon;
  run: (selection: TextSelection) => void;
}

/** Built-in chat actions (F-CHAT-02); annotations add "Subrayar" through `extra`. */
function chatActions(): SelectionAction[] {
  const { send, attach } = useChat.getState();
  const show = () => useChatDock.getState().show();
  return [
    {
      id: 'ask',
      label: t.chat.selection.ask,
      icon: MessageSquare,
      run: (selection) => {
        attach(selection);
        show();
        setTimeout(() => window.dispatchEvent(new CustomEvent('pca:focus-composer')), 50);
      },
    },
    {
      id: 'eli5',
      label: t.chat.selection.eli5,
      icon: Lightbulb,
      run: (selection) => {
        show();
        send('', { mode: 'eli5', selection });
      },
    },
    {
      id: 'summarize',
      label: t.chat.selection.summarize,
      icon: ListTree,
      run: (selection) => {
        show();
        send(t.chat.selection.summarizePrompt, { mode: 'summary', selection });
      },
    },
    {
      id: 'quiz',
      label: t.chat.selection.quiz,
      icon: HelpCircle,
      run: (selection) => {
        show();
        send(t.chat.selection.quizPrompt, { mode: 'exam', selection });
      },
    },
  ];
}

/**
 * Floating menu over a text selection in the PDF. Shown below the selection on touch
 * screens so it does not collide with the system's copy/paste callout.
 */
export function SelectionMenu({
  root,
  extra = [],
}: {
  root: HTMLElement | null;
  extra?: SelectionAction[];
}) {
  const [current, setCurrent] = useState<Current | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [coarse] = useState(() => window.matchMedia('(pointer: coarse)').matches);

  useEffect(() => {
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Wait for the selection to settle (drag or handle adjustment) before showing.
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setCurrent(readSelection(root)), coarse ? 400 : 150);
    };
    const hide = () => setCurrent(null);
    document.addEventListener('selectionchange', update);
    root.addEventListener('scroll', hide, { passive: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', update);
      root.removeEventListener('scroll', hide);
    };
  }, [root, coarse]);

  if (!current) return null;
  const actions = [...chatActions(), ...extra];
  const { rect } = current;
  const width = Math.min(window.innerWidth - 16, coarse ? 360 : 560);
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - width / 2),
    window.innerWidth - width - 8,
  );
  const above = !coarse && rect.top > 64;
  const style = above
    ? { left, width, bottom: window.innerHeight - rect.top + MENU_GAP }
    : { left, width, top: Math.min(rect.bottom + MENU_GAP, window.innerHeight - 120) };

  const run = (action: SelectionAction) => {
    action.run(current.selection);
    window.getSelection()?.removeAllRanges();
    setCurrent(null);
  };

  return (
    <div
      ref={menu}
      role="toolbar"
      aria-label={t.chat.selection.menu}
      className="fixed z-40 flex justify-center"
      style={style}
      // Keep the selection alive when pressing a button.
      onPointerDown={(e) => e.preventDefault()}
    >
      <div className="border-border bg-surface flex flex-wrap justify-center gap-0.5 rounded-xl border p-1 shadow-lg">
        {actions.map((a) => (
          <MenuButton key={a.id} onClick={() => run(a)} label={a.label}>
            <a.icon size={16} aria-hidden />
          </MenuButton>
        ))}
      </div>
    </div>
  );
}

function MenuButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-surface-muted flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap"
    >
      {children}
      {label}
    </button>
  );
}
