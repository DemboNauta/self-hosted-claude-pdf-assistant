import { MousePointer2 } from 'lucide-react';
import { createContext, useContext } from 'react';
import { t } from '../../i18n';
import { CITATION_EVENT } from './CitationChip';
import { useChat } from './store';

/** The answer a Markdown body belongs to, so its `[[mark:ID]]` chips find their marks. */
export const MessageIdContext = createContext<string | null>(null);

/**
 * Where an answer refers to marks Claude drew on the PDF (`[[mark:m1]]`): shows them
 * again on the page. Hidden when the marks are unknown (e.g. outside the chat).
 */
export function MarkChip({ markId }: { markId: string }) {
  const messageId = useContext(MessageIdContext);
  const group = useChat((s) =>
    messageId
      ? s.messages.find((m) => m.id === messageId)?.pointers?.find((g) => g.id === markId)
      : undefined,
  );
  const visible = useChat((s) =>
    s.pointers.some((g) => g.messageId === messageId && g.id === markId),
  );
  if (!messageId || !group) return null;
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(CITATION_EVENT));
        useChat.getState().showMarks(messageId, markId);
      }}
      title={t.chat.pointers.showMark(group.page)}
      aria-label={t.chat.pointers.showMark(group.page)}
      aria-pressed={visible}
      className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-orange-600/10 px-1.5 py-0.5 align-baseline text-xs font-medium whitespace-nowrap text-orange-700 hover:bg-orange-600/20 aria-pressed:bg-orange-600/20 dark:text-orange-300"
      data-testid="mark-chip"
    >
      <MousePointer2 size={12} aria-hidden className="shrink-0" />
      p. {group.page}
    </button>
  );
}
