import {
  STUDY_MODES,
  SUMMARY_FORMATS,
  type ChatMessage,
  type ToolEvent,
} from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import {
  AlertCircle,
  ArrowUp,
  Check,
  Copy,
  History,
  Loader2,
  Plus,
  Quote,
  Square,
  X,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Menu } from '../../components/Menu';
import { t } from '../../i18n';
import { Markdown } from './Markdown';
import { useChat } from './store';

function ToolLine({ event }: { event: ToolEvent }) {
  const label = t.chat.tools[event.name] ?? event.name;
  return (
    <li className="text-text-muted flex items-center gap-1.5 text-xs">
      {event.status === 'running' ? (
        <Loader2 size={12} aria-hidden className="animate-spin" />
      ) : event.status === 'error' ? (
        <AlertCircle size={12} aria-hidden className="text-danger" />
      ) : (
        <Check size={12} aria-hidden />
      )}
      <span>
        {label}
        {event.summary && ` ${event.summary}`}
      </span>
    </li>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label={copied ? t.chat.copied : t.chat.copy}
      title={copied ? t.chat.copied : t.chat.copy}
      className="text-text-muted hover:text-text rounded p-1"
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

function MessageItem({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    const sel = message.context?.selection;
    const mode = message.mode && message.mode !== 'free' ? t.chat.modes[message.mode] : null;
    return (
      <li className="flex flex-col items-end gap-1" data-testid="user-message">
        {(mode || sel) && (
          <span className="text-text-muted text-xs">
            {[mode, sel && t.chat.attached(sel.page)].filter(Boolean).join(' · ')}
          </span>
        )}
        {sel && (
          <blockquote className="border-border text-text-muted line-clamp-3 max-w-[90%] border-l-2 pl-2 text-xs italic">
            {sel.text}
          </blockquote>
        )}
        {message.content && (
          <p className="bg-surface-muted max-w-[90%] rounded-2xl rounded-br-md px-3 py-2 text-sm whitespace-pre-wrap">
            {message.content}
          </p>
        )}
      </li>
    );
  }
  const streaming = message.status === 'streaming';
  return (
    <li className="group space-y-1.5" data-testid="assistant-message">
      {message.toolEvents && message.toolEvents.length > 0 && (
        <ul className="space-y-0.5">
          {message.toolEvents.map((e) => (
            <ToolLine key={e.id} event={e} />
          ))}
        </ul>
      )}
      {message.content ? (
        <Markdown text={message.content} streaming={streaming} />
      ) : streaming ? (
        <p className="text-text-muted flex items-center gap-2 text-sm">
          <Loader2 size={14} aria-hidden className="animate-spin" />
          {t.chat.thinking}
        </p>
      ) : null}
      {message.status === 'interrupted' && (
        <p className="text-text-muted text-xs italic">{t.chat.interrupted}</p>
      )}
      {!streaming && message.content && (
        <div className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <CopyButton text={message.content} />
        </div>
      )}
    </li>
  );
}

function MessageList() {
  const messages = useChat((s) => s.messages);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the stream unless the reader scrolled up to re-read something.
  useLayoutEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      aria-live="polite"
      aria-busy={useChat.getState().running}
    >
      {messages.length === 0 ? (
        <p className="text-text-muted mt-6 text-center text-sm">{t.chat.empty}</p>
      ) : (
        <ul className="space-y-5">
          {messages.map((m) => (
            <MessageItem key={m.id} message={m} />
          ))}
        </ul>
      )}
      <div ref={bottom} />
    </div>
  );
}

function ModeBar() {
  const mode = useChat((s) => s.mode);
  const setMode = useChat((s) => s.setMode);
  const format = useChat((s) => s.summaryFormat);
  const setFormat = useChat((s) => s.setSummaryFormat);
  return (
    <div className="space-y-1.5">
      <div role="radiogroup" aria-label={t.chat.modes.label} className="flex flex-wrap gap-1">
        {STUDY_MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            title={t.chat.modeHints[m] || undefined}
            onClick={() => setMode(m)}
            className={clsx(
              'shrink-0 rounded-full border px-2.5 py-1 text-xs whitespace-nowrap',
              mode === m
                ? 'border-text bg-text text-bg'
                : 'border-border text-text-muted hover:text-text',
            )}
          >
            {t.chat.modes[m]}
          </button>
        ))}
      </div>
      {mode !== 'free' && (
        <div className="text-text-muted flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1">{t.chat.modeHints[mode]}</span>
          {mode === 'summary' && (
            <select
              aria-label={t.chat.summaryFormats.label}
              value={format}
              onChange={(e) => setFormat(e.target.value as typeof format)}
              className="bg-bg border-border rounded border px-1 py-0.5"
            >
              {SUMMARY_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {t.chat.summaryFormats[f]}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}

export const COMPOSER_ID = 'chat-composer';

function Composer() {
  const [text, setText] = useState('');
  const running = useChat((s) => s.running);
  const attached = useChat((s) => s.attached);
  const mode = useChat((s) => s.mode);
  const { send, stop, attach } = useChat.getState();
  const area = useRef<HTMLTextAreaElement>(null);

  // Grow with the content up to a few lines.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const canSend = !running && (text.trim().length > 0 || attached !== null || mode !== 'free');
  const submit = () => {
    if (!canSend) return;
    send(text.trim());
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-border space-y-2 border-t p-3">
      <ModeBar />
      {attached && (
        <div className="bg-surface-muted flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs">
          <Quote size={12} aria-hidden className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t.chat.attached(attached.page)}</p>
            <p className="text-text-muted line-clamp-2">{attached.text}</p>
          </div>
          <button
            type="button"
            onClick={() => attach(null)}
            aria-label={t.chat.removeAttached}
            className="text-text-muted hover:text-text rounded p-0.5"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
      <div className="border-border bg-bg focus-within:border-text flex items-end gap-2 rounded-xl border px-3 py-2">
        <textarea
          id={COMPOSER_ID}
          ref={area}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={attached ? t.chat.placeholderSelection : t.chat.placeholder}
          aria-label={t.chat.placeholder}
          className="max-h-40 min-w-0 flex-1 resize-none bg-transparent text-base outline-none sm:text-sm"
        />
        {running ? (
          <button
            type="button"
            onClick={stop}
            aria-label={t.chat.stop}
            title={t.chat.stop}
            className="bg-text text-bg rounded-full p-1.5"
          >
            <Square size={14} aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label={t.chat.send}
            title={t.chat.send}
            className="bg-text text-bg rounded-full p-1.5 disabled:opacity-30"
          >
            <ArrowUp size={14} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

function ErrorBanner() {
  const error = useChat((s) => s.error);
  const dismiss = useChat((s) => s.dismissError);
  if (!error) return null;
  return (
    <div
      role="alert"
      className="border-danger/40 text-danger mx-3 mt-3 flex gap-2 rounded-lg border px-3 py-2 text-sm"
    >
      <AlertCircle size={16} aria-hidden className="mt-0.5 shrink-0" />
      <p className="min-w-0 flex-1">{t.chat.errors[error.code]}</p>
      <button type="button" onClick={dismiss} aria-label={t.reader.closePanel} className="shrink-0">
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

const dateFmt = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function ThreadControls() {
  const threads = useChat((s) => s.threads);
  const threadId = useChat((s) => s.threadId);
  const running = useChat((s) => s.running);
  const { newThread, openThread } = useChat.getState();
  const others = threads.filter((th) => th.messageCount > 0 || th.id === threadId);
  return (
    <div className="flex items-center">
      {others.length > 1 && (
        <Menu
          label={t.chat.history}
          icon={<History size={16} aria-hidden />}
          actions={others.map((th) => ({
            label: `${th.id === threadId ? '• ' : ''}${th.title ?? t.chat.untitled} — ${dateFmt.format(new Date(th.updatedAt))}`,
            onSelect: () => void openThread(th.id),
          }))}
        />
      )}
      <button
        type="button"
        onClick={() => void newThread()}
        disabled={running}
        aria-label={t.chat.newThread}
        title={t.chat.newThread}
        className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5 disabled:opacity-40"
      >
        <Plus size={16} aria-hidden />
      </button>
    </div>
  );
}

/** Chat with Claude about the open document (F-CHAT-01/03/05/07). */
export function ChatPanel({ headerActions }: { headerActions?: ReactNode }) {
  const connected = useChat((s) => s.connected);
  const title = useChat((s) => s.threads.find((th) => th.id === s.threadId)?.title);

  useEffect(() => {
    const focus = () => document.getElementById(COMPOSER_ID)?.focus();
    window.addEventListener('pca:focus-composer', focus);
    return () => window.removeEventListener('pca:focus-composer', focus);
  }, []);

  return (
    <section aria-label={t.chat.title} className="bg-surface flex h-full min-h-0 flex-col">
      <header className="border-border flex items-center gap-1 border-b px-3 py-1.5">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {title ?? t.chat.title}
          {!connected && (
            <span className="text-text-muted ml-2 text-xs font-normal">{t.chat.offline}</span>
          )}
        </h2>
        <ThreadControls />
        {headerActions}
      </header>
      <ErrorBanner />
      <MessageList />
      <Composer />
    </section>
  );
}
