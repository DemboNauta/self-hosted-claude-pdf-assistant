import { MousePointer2, Presentation } from 'lucide-react';
import { createContext, useContext } from 'react';
import { t } from '../../i18n';
import { showStep, useBoard } from '../whiteboard/store';
import { CITATION_EVENT } from './CitationChip';
import { useChat } from './store';

/** The answer a Markdown body belongs to, so its `[[mark:ID]]` chips find their marks. */
export const MessageIdContext = createContext<string | null>(null);

const chipClass =
  'mx-0.5 inline-flex items-center gap-1 rounded-md bg-orange-600/10 px-1.5 py-0.5 align-baseline text-xs font-medium whitespace-nowrap text-orange-700 hover:bg-orange-600/20 aria-pressed:bg-orange-600/20 dark:text-orange-300';

/** `[[mark:w1]]`: a step Claude drew on the whiteboard; shows the board there. */
function BoardChip({ messageId, stepId }: { messageId: string; stepId: string }) {
  const known = useBoard((s) =>
    s.steps.some((st) => st.messageId === messageId && st.id === stepId),
  );
  if (!known) return null;
  return (
    <button
      type="button"
      onClick={() => showStep(messageId, stepId)}
      title={t.board.showStep}
      aria-label={t.board.showStep}
      className={chipClass}
      data-testid="board-chip"
    >
      <Presentation size={12} aria-hidden className="shrink-0" />
      {t.board.chip}
    </button>
  );
}

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
  if (messageId && markId.startsWith('w'))
    return <BoardChip messageId={messageId} stepId={markId} />;
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
      className={chipClass}
      data-testid="mark-chip"
    >
      <MousePointer2 size={12} aria-hidden className="shrink-0" />
      p. {group.page}
    </button>
  );
}
