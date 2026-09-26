import type { DocumentQuestion } from '@pdfclaudeassistant/shared';
import { useQuery } from '@tanstack/react-query';
import { MessageCircleQuestion, MessagesSquare, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { queryClient } from '../../lib/queryClient';
import type { PageLayers } from '../reader/PdfPage';
import { unionRect } from '../reader/PointerLayer';
import { useReader } from '../reader/store';
import { findQuoteRects, type NormRect } from '../reader/textMatch';
import { useChatDock } from './ChatDock';
import { CITATION_EVENT } from './CitationChip';
import { Markdown } from './Markdown';
import { chatSocket, useChat } from './store';

export const questionsKey = (docId: string) => ['questions', docId] as const;

export function useDocumentQuestions(docId: string) {
  return useQuery({
    queryKey: questionsKey(docId),
    queryFn: () => api<DocumentQuestion[]>(`/documents/${docId}/questions`),
  });
}

let installed = false;

/** Refreshes the marks when a question about the open document is asked or answered. */
function installRefresh() {
  if (installed) return;
  installed = true;
  chatSocket.subscribe((event) => {
    if (event.type !== 'user_message' && event.type !== 'assistant_done') return;
    const scope = useChat.getState().scope;
    if (scope?.kind === 'document') {
      void queryClient.invalidateQueries({ queryKey: questionsKey(scope.id) });
    }
  });
}

/** Questions about the same passage share one mark. */
interface Group {
  key: string;
  questions: DocumentQuestion[];
  rects: NormRect[];
}

const BADGE = 22;
const MARGIN = 6;

/**
 * Marks on a page where the student asked Claude about a selection or a drawn area:
 * a dotted underline and a small button that shows the questions and Claude's answers.
 */
export function QuestionMarks({
  docId,
  page,
  layers,
  width,
  height,
}: {
  docId: string;
  page: number;
  layers: PageLayers;
  width: number;
  height: number;
}) {
  installRefresh();
  const { data } = useDocumentQuestions(docId);
  const visible = useReader((s) => s.filter.visible);
  const [open, setOpen] = useState<Group | null>(null);
  const { textLayer, pageEl } = layers;

  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    for (const q of data ?? []) {
      if (q.page !== page) continue;
      const key = `${q.kind}:${q.quote}:${JSON.stringify(q.kind === 'mark' ? q.rects : [])}`;
      const g = map.get(key);
      if (g) g.questions.push(q);
      else map.set(key, { key, questions: [q], rects: q.rects });
    }
    // Passages the server could not place are looked up in the rendered text layer.
    for (const g of map.values()) {
      if (g.rects.length || !textLayer || !pageEl) continue;
      g.rects = findQuoteRects(textLayer, pageEl, g.questions[0]!.quote)[0] ?? [];
    }
    return [...map.values()].filter((g) => g.rects.length > 0);
  }, [data, page, textLayer, pageEl]);

  // Badges sit in the right margin, like margin notes, so they never cover the text;
  // marks on nearby lines are nudged down so they do not overlap.
  const placed = useMemo(() => {
    const wanted = groups
      .map((g) => {
        const box = unionRect(g.rects)!;
        return { g, top: (box.y + box.h / 2) * height - BADGE / 2 };
      })
      .sort((a, b) => a.top - b.top);
    for (let i = 0; i < wanted.length; i++) {
      const floor = i > 0 ? wanted[i - 1]!.top + BADGE + 4 : 0;
      wanted[i]!.top = Math.min(Math.max(wanted[i]!.top, floor), height - BADGE);
    }
    return wanted;
  }, [groups, height]);

  if (!visible || !placed.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0" data-testid="question-marks">
      {placed.map(({ g, top }) => {
        const mark = g.questions[0]!.kind === 'mark';
        const left = width - BADGE - MARGIN;
        return (
          <div key={g.key}>
            {!mark &&
              g.rects.map((r, i) => (
                <div
                  key={i}
                  aria-hidden
                  className="absolute border-b-2 border-dotted border-orange-500/70"
                  style={{
                    left: r.x * width,
                    top: r.y * height,
                    width: r.w * width,
                    height: r.h * height + 1,
                  }}
                />
              ))}
            <button
              type="button"
              onClick={() => setOpen(g)}
              aria-label={t.chat.questions.open(g.questions.length)}
              title={t.chat.questions.open(g.questions.length)}
              className="pointer-events-auto absolute flex items-center justify-center rounded-full bg-orange-600 text-white shadow ring-2 ring-white hover:bg-orange-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700"
              style={{ left, top, width: BADGE, height: BADGE }}
              data-testid="question-mark"
            >
              <MessageCircleQuestion size={14} aria-hidden />
              {g.questions.length > 1 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-4 rounded-full bg-white px-1 text-[10px] leading-4 font-semibold text-orange-700 shadow">
                  {g.questions.length}
                </span>
              )}
            </button>
          </div>
        );
      })}
      {open && <QuestionsDialog group={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

const dateFmt = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** The questions asked about one passage, each with Claude's answer. */
function QuestionsDialog({ group, onClose }: { group: Group; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const first = group.questions[0]!;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    // A citation in an answer moves the reader: get out of the way.
    const close = () => ref.current?.close();
    window.addEventListener(CITATION_EVENT, close);
    return () => window.removeEventListener(CITATION_EVENT, close);
  }, []);

  const openInChat = async (q: DocumentQuestion) => {
    ref.current?.close();
    const chat = useChat.getState();
    if (chat.threadId !== q.threadId) await chat.openThread(q.threadId);
    useChatDock.getState().show();
    setTimeout(() => {
      document
        .querySelector(`[data-message-id="${q.id}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 100);
  };

  // Portalled: events inside must not reach the page's pointer handlers.
  return createPortal(
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()}
      aria-labelledby="questions-title"
      className="bg-surface text-text m-auto flex max-h-[85vh] w-[min(36rem,calc(100%-2rem))] flex-col rounded-xl p-0 shadow-xl backdrop:bg-black/40"
    >
      <header className="border-border flex items-center gap-2 border-b px-4 py-3">
        <MessageCircleQuestion size={16} aria-hidden className="text-orange-600" />
        <h2 id="questions-title" className="min-w-0 flex-1 text-sm font-medium">
          {t.chat.questions.title(first.page)}
        </h2>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          aria-label={t.chat.questions.close}
          className="text-text-muted hover:text-text rounded p-1"
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {first.quote ? (
          <blockquote className="border-border text-text-muted line-clamp-4 border-l-2 pl-2 text-xs italic">
            {first.quote}
          </blockquote>
        ) : (
          <p className="text-text-muted text-xs italic">{t.chat.questions.markNoText}</p>
        )}
        <ol className="space-y-5">
          {group.questions.map((q) => (
            <li key={q.id} className="space-y-2" data-testid="asked-question">
              <p className="text-text-muted text-xs">
                {dateFmt.format(new Date(q.createdAt))}
                {q.mode !== 'free' && ` · ${t.chat.modes[q.mode]}`}
              </p>
              {q.question && (
                <p className="bg-surface-muted rounded-2xl rounded-br-md px-3 py-2 text-sm whitespace-pre-wrap">
                  {q.question}
                </p>
              )}
              {q.answer ? (
                <Markdown text={q.answer} />
              ) : (
                <p className="text-text-muted text-sm italic">
                  {q.answerStatus === 'error' || q.answerStatus === 'interrupted'
                    ? t.chat.questions.noAnswer
                    : t.chat.questions.pending}
                </p>
              )}
              <button
                type="button"
                onClick={() => void openInChat(q)}
                className="text-text-muted hover:text-text flex items-center gap-1 text-xs font-medium hover:underline"
              >
                <MessagesSquare size={12} aria-hidden />
                {t.chat.questions.openInChat}
              </button>
            </li>
          ))}
        </ol>
      </div>
    </dialog>,
    document.body,
  );
}
