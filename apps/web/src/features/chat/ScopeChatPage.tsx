import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { t } from '../../i18n';
import { useLibrary } from '../library/api';
import { useReader } from '../reader/store';
import { ChatPanel } from './ChatPanel';
import { useChat } from './store';

/** Chat about a whole topic or subject (F-CHAT-08): Claude reads and cites all its PDFs. */
export function ScopeChatPage({ kind }: { kind: 'topic' | 'subject' }) {
  const { id = '' } = useParams();
  const library = useLibrary();

  useEffect(() => {
    // No document is open: citations navigate to the reader.
    useReader.setState({ docId: null });
    void useChat.getState().openScope({ kind, id });
  }, [kind, id]);

  let name = '';
  let back = '/library';
  for (const s of library.data?.subjects ?? []) {
    if (kind === 'subject' && s.id === id) name = s.name;
    const topic = s.topics.find((tp) => tp.id === id);
    if (kind === 'topic' && topic) {
      name = `${s.name} · ${topic.name}`;
      back = `/library/t/${topic.id}`;
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
      <header className="flex items-center gap-2 px-4 pt-4 pb-2">
        <Link
          to={back}
          aria-label={t.reader.back}
          className="text-text-muted hover:text-text rounded-md p-1.5"
        >
          <ArrowLeft size={18} aria-hidden />
        </Link>
        <div className="min-w-0">
          <p className="text-text-muted text-xs">
            {kind === 'topic' ? t.chat.scope.topic : t.chat.scope.subject}
          </p>
          <h1 className="truncate font-serif text-xl">{name}</h1>
        </div>
      </header>
      <div className="border-border min-h-0 flex-1 overflow-hidden border-t sm:mx-4 sm:mb-4 sm:rounded-xl sm:border">
        <ChatPanel />
      </div>
    </div>
  );
}
