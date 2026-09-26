import type { Annotation } from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { Check, MessageSquare, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { useChatDock } from '../chat/ChatDock';
import { useChat } from '../chat/store';
import type { NormRect } from '../reader/textMatch';
import { deleteAnnotations, setProposalStatus, updateAnnotation, usePalette } from './api';

/** Edit an annotation in place: colour, comment, delete; accept/discard proposals. */
export function AnnotationPopover({
  docId,
  annotation: a,
  box,
  onClose,
}: {
  docId: string;
  annotation: Annotation;
  box: NormRect | null;
  onClose: () => void;
}) {
  const { palette, colorOf } = usePalette();
  const [text, setText] = useState(a.content ?? '');
  const area = useRef<HTMLTextAreaElement>(null);
  const quote = (a.anchor as { quote?: string }).quote;
  const proposal = a.status === 'proposed';
  const editable = a.type === 'highlight' || a.type === 'note';

  useEffect(() => {
    if (a.type === 'note' && !a.content) area.current?.focus();
  }, [a.type, a.content]);

  const saveText = () => {
    const content = text.trim() || null;
    if (content !== (a.content ?? null)) void updateAnnotation(docId, a, { content });
  };

  const top = box ? box.y + box.h : 0.1;
  const below = top < 0.75;
  return (
    <div
      data-annotation-ui
      role="dialog"
      aria-label={t.annotations.edit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className="border-border bg-surface text-text absolute z-30 w-64 rounded-xl border p-3 text-sm shadow-xl"
      style={{
        left: `clamp(4px, ${(box?.x ?? 0.5) * 100}%, calc(100% - 260px))`,
        ...(below
          ? { top: `calc(${top * 100}% + 8px)` }
          : { bottom: `calc(${(1 - (box?.y ?? 0.9)) * 100}% + 8px)` }),
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-text-muted text-xs">
          {a.author === 'claude' ? t.annotations.byClaude : t.annotations.byYou} · p. {a.page}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.reader.closePanel}
          className="text-text-muted hover:text-text"
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      {proposal ? (
        <>
          {a.content && <p className="mb-3">{a.content}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                void setProposalStatus(docId, [a.id], 'active');
                onClose();
              }}
              className="bg-accent text-accent-contrast flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5"
            >
              <Check size={14} aria-hidden />
              {t.annotations.accept}
            </button>
            <button
              type="button"
              onClick={() => {
                void setProposalStatus(docId, [a.id], 'rejected');
                onClose();
              }}
              className="border-border flex-1 rounded-lg border px-2 py-1.5"
            >
              {t.annotations.reject}
            </button>
          </div>
        </>
      ) : (
        <>
          {editable && (
            <div role="radiogroup" aria-label={t.annotations.color} className="mb-2 flex gap-1.5">
              {palette.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={a.color === p.key}
                  aria-label={p.meaning}
                  title={p.meaning}
                  onClick={() => void updateAnnotation(docId, a, { color: p.key })}
                  className={clsx(
                    'size-6 rounded-full ring-offset-2',
                    a.color === p.key && 'ring-text ring-2',
                  )}
                  style={{ background: colorOf(p.key) }}
                />
              ))}
            </div>
          )}
          {editable && (
            <textarea
              ref={area}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={saveText}
              rows={3}
              placeholder={
                a.type === 'note' ? t.annotations.notePlaceholder : t.annotations.commentPlaceholder
              }
              aria-label={t.annotations.comment}
              className="border-border bg-bg mb-2 w-full resize-y rounded-lg border px-2 py-1.5 text-sm"
            />
          )}
          <div className="flex items-center gap-1">
            {quote && (
              <button
                type="button"
                onClick={() => {
                  useChat.getState().attach({ page: a.page, text: quote });
                  useChatDock.getState().show();
                  onClose();
                }}
                className="hover:bg-surface-muted flex items-center gap-1 rounded-md px-2 py-1"
              >
                <MessageSquare size={14} aria-hidden />
                {t.chat.selection.ask}
              </button>
            )}
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => {
                void deleteAnnotations(docId, [a]);
                onClose();
              }}
              aria-label={t.annotations.delete}
              title={t.annotations.delete}
              className="text-danger hover:bg-surface-muted rounded-md p-1.5"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
