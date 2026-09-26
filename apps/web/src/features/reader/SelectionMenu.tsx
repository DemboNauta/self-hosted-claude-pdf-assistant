import type { TextSelection } from '@pdfclaudeassistant/shared';
import { HelpCircle, Lightbulb, ListTree, MessageSquare, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { useChatDock } from '../chat/ChatDock';
import { useChat } from '../chat/store';
import type { NormRect } from './textMatch';

interface Current {
  selection: TextSelection;
  /** Selected text boxes on the selection's first page, in normalised page space. */
  rects: NormRect[];
  /** Selection box in viewport coordinates. */
  rect: DOMRect;
}

const MENU_GAP = 8;

/** Reads the current text-layer selection inside `root`, if any. */
export function readSelection(root: HTMLElement): Current | null {
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
  const box = pageEl.getBoundingClientRect();
  const rects = [...range.getClientRects()]
    .filter(
      (r) => r.width > 0.5 && r.height > 0.5 && r.bottom <= box.bottom + 2 && r.top >= box.top - 2,
    )
    .map((r) => ({
      x: (r.left - box.left) / box.width,
      y: (r.top - box.top) / box.height,
      w: r.width / box.width,
      h: r.height / box.height,
    }));
  return {
    selection: { page: Number(pageEl.dataset.page), text: text.slice(0, 8000) },
    rect,
    rects: mergeRects(rects),
  };
}

export interface SelectionAction {
  id: string;
  label: string;
  /** Icon, or a colour dot for highlight colours. */
  icon?: LucideIcon;
  color?: string;
  run: (selection: TextSelection, rects: NormRect[]) => void;
}

/** Joins the per-span boxes of each line into one rectangle per line. */
function mergeRects(rects: NormRect[]): NormRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: NormRect[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && Math.abs(last.y - r.y) < r.h * 0.5 && r.x <= last.x + last.w + 0.02) {
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = x2 - last.x;
      last.h = y2 - last.y;
    } else out.push({ ...r });
  }
  return out;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The selection plus where it is, kept with the question to mark it on the page. */
function located(selection: TextSelection, rects: NormRect[]): TextSelection {
  const inPage = rects.slice(0, 200).map((r) => {
    const x = clamp01(r.x);
    const y = clamp01(r.y);
    return { x, y, w: clamp01(r.x + r.w) - x, h: clamp01(r.y + r.h) - y };
  });
  return inPage.length ? { ...selection, rects: inPage } : selection;
}

/** Built-in chat actions (F-CHAT-02); annotations add "Subrayar" through `extra`. */
function chatActions(): SelectionAction[] {
  const { send: sendRaw, attach } = useChat.getState();
  const show = () => useChatDock.getState().show();
  const send = (text: string, opts: Parameters<typeof sendRaw>[1] & { rects: NormRect[] }) => {
    const { rects, ...rest } = opts;
    sendRaw(text, {
      ...rest,
      ...(rest.selection && { selection: located(rest.selection, rects) }),
    });
  };
  return [
    {
      id: 'ask',
      label: t.chat.selection.ask,
      icon: MessageSquare,
      run: (selection, rects) => {
        attach(located(selection, rects));
        show();
        setTimeout(() => window.dispatchEvent(new CustomEvent('pca:focus-composer')), 50);
      },
    },
    {
      id: 'eli5',
      label: t.chat.selection.eli5,
      icon: Lightbulb,
      run: (selection, rects) => {
        show();
        send('', { mode: 'eli5', selection, rects });
      },
    },
    {
      id: 'summarize',
      label: t.chat.selection.summarize,
      icon: ListTree,
      run: (selection, rects) => {
        show();
        send(t.chat.selection.summarizePrompt, { mode: 'summary', selection, rects });
      },
    },
    {
      id: 'quiz',
      label: t.chat.selection.quiz,
      icon: HelpCircle,
      run: (selection, rects) => {
        show();
        send(t.chat.selection.quizPrompt, { mode: 'exam', selection, rects });
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
    action.run(current.selection, current.rects);
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
        {actions.map((a) =>
          a.color ? (
            <button
              key={a.id}
              type="button"
              onClick={() => run(a)}
              aria-label={a.label}
              title={a.label}
              className="hover:bg-surface-muted flex min-h-10 min-w-9 items-center justify-center rounded-lg"
            >
              <span
                aria-hidden
                className="size-5 rounded-full ring-1 ring-black/10"
                style={{ background: a.color }}
              />
            </button>
          ) : (
            <MenuButton key={a.id} onClick={() => run(a)} label={a.label}>
              {a.icon && <a.icon size={16} aria-hidden />}
            </MenuButton>
          ),
        )}
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
