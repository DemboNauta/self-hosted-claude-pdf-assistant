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
  Mic,
  MousePointer2,
  PenLine,
  Plus,
  Quote,
  Square,
  Volume2,
  VolumeX,
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
import { useShallow } from 'zustand/react/shallow';
import { Menu } from '../../components/Menu';
import { t } from '../../i18n';
import { useReader } from '../reader/store';
import { useVoice } from '../voice/store';
import { VoiceBar, VoiceToggle, voiceSupported } from '../voice/VoiceBar';
import { CITATION_EVENT } from './CitationChip';
import { dictationSupported, useDictation } from './dictation';
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

/** "Claude pointed at p. N — Go · Clear" under the answer that drew the marks. */
function PointerBar({ messageId }: { messageId: string }) {
  const groups = useChat(useShallow((s) => s.pointers.filter((g) => g.messageId === messageId)));
  const clear = useChat((s) => s.clearPointers);
  if (!groups.length) return null;
  const pages = [...new Set(groups.map((g) => g.page))];
  return (
    <div className="border-border flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2 py-1.5 text-xs">
      <MousePointer2 size={12} aria-hidden className="text-orange-600" />
      {pages.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent(CITATION_EVENT));
            useReader.getState().goTo(p);
          }}
          className="hover:underline"
        >
          {t.chat.pointers.shown(p)} · {t.chat.pointers.go}
        </button>
      ))}
      <span className="flex-1" />
      {extraPointerActions(messageId)}
      <button
        type="button"
        onClick={() => clear(messageId)}
        className="text-text-muted hover:text-text"
      >
        {t.chat.pointers.clear}
      </button>
    </div>
  );
}

/** Hook for later features (saving marks as annotations). */
let extraPointerActions: (messageId: string) => ReactNode = () => null;
export function setPointerActions(fn: (messageId: string) => ReactNode) {
  extraPointerActions = fn;
}

/** Reads an answer aloud with Claude's voice (outside voice mode). */
function ReadAloudButton({ message }: { message: ChatMessage }) {
  const reading = useVoice((s) => s.readingId === message.id);
  const voiceMode = useVoice((s) => s.active);
  if (voiceMode) return null;
  const label = reading ? t.voice.stopReading : t.voice.read;
  return (
    <button
      type="button"
      onClick={() =>
        reading ? useVoice.getState().stopReading() : void useVoice.getState().read(message)
      }
      aria-label={label}
      title={label}
      className="text-text-muted hover:text-text rounded p-1"
    >
      {reading ? <VolumeX size={14} aria-hidden /> : <Volume2 size={14} aria-hidden />}
    </button>
  );
}

function MessageItem({ message }: { message: ChatMessage }) {
  if (message.role === 'user' && message.context?.continueExplaining) {
    // Voice mode carrying on by itself (podcast style): a quiet separator, not a bubble.
    return (
      <li className="text-text-muted text-center text-xs" data-testid="voice-continue">
        · {t.voice.continued} ·
      </li>
    );
  }
  if (message.role === 'user') {
    const sel = message.context?.selection;
    const mark = message.context?.mark;
    const mode = message.mode && message.mode !== 'free' ? t.chat.modes[message.mode] : null;
    const quoted = sel?.text ?? mark?.text;
    return (
      <li
        className="flex scroll-mt-4 flex-col items-end gap-1"
        data-testid="user-message"
        data-message-id={message.id}
      >
        {(mode || sel || mark) && (
          <span className="text-text-muted text-xs">
            {[mode, sel && t.chat.attached(sel.page), mark && t.chat.attachedMark(mark.page)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        {quoted && (
          <blockquote className="border-border text-text-muted line-clamp-3 max-w-[90%] border-l-2 pl-2 text-xs italic">
            {quoted}
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
      <PointerBar messageId={message.id} />
      {message.status === 'interrupted' && (
        <p className="text-text-muted text-xs italic">{t.chat.interrupted}</p>
      )}
      {!streaming && message.content && (
        <div className="flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <CopyButton text={message.content} />
          <ReadAloudButton message={message} />
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
      {mode === 'diagram' && <DiagramScope />}
    </div>
  );
}

/** Whole PDF or a page range for the next diagram (document chats only). */
function DiagramScope() {
  const scope = useChat((s) => s.scope);
  const range = useChat((s) => s.diagramRange);
  const setRange = useChat((s) => s.setDiagramRange);
  const pageCount = useReader((s) => s.pageCount);
  const current = useReader((s) => s.currentPage);
  if (scope?.kind !== 'document' || pageCount < 2) return null;
  const clamp = (n: number) => Math.min(Math.max(1, Math.round(n) || 1), pageCount);
  const input =
    'bg-bg border-border w-14 rounded border px-1 py-0.5 text-center tabular-nums disabled:opacity-40';
  return (
    <div
      role="group"
      aria-label={t.chat.diagramScope.label}
      className="text-text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
    >
      <label className="flex items-center gap-1">
        <input type="radio" checked={!range} onChange={() => setRange(null)} />
        {t.chat.diagramScope.whole}
      </label>
      <label className="flex items-center gap-1">
        <input
          type="radio"
          checked={!!range}
          onChange={() => setRange({ from: current, to: Math.min(pageCount, current + 4) })}
        />
        {t.chat.diagramScope.pages}
      </label>
      <input
        type="number"
        min={1}
        max={pageCount}
        disabled={!range}
        aria-label={t.chat.diagramScope.from}
        value={range?.from ?? current}
        onChange={(e) => {
          const from = clamp(Number(e.target.value));
          setRange({ from, to: Math.max(from, range?.to ?? from) });
        }}
        className={input}
      />
      –
      <input
        type="number"
        min={1}
        max={pageCount}
        disabled={!range}
        aria-label={t.chat.diagramScope.to}
        value={range?.to ?? Math.min(pageCount, current + 4)}
        onChange={(e) => {
          const to = clamp(Number(e.target.value));
          setRange({ from: Math.min(range?.from ?? to, to), to });
        }}
        className={input}
      />
    </div>
  );
}

export const COMPOSER_ID = 'chat-composer';

function Composer() {
  const [text, setText] = useState('');
  const running = useChat((s) => s.running);
  const attached = useChat((s) => s.attached);
  const attachedMark = useChat((s) => s.attachedMark);
  const mode = useChat((s) => s.mode);
  const { send, stop, attach, attachMark } = useChat.getState();
  const area = useRef<HTMLTextAreaElement>(null);
  const [canDictate] = useState(dictationSupported);
  const [canTalk] = useState(voiceSupported);
  const voiceMode = useVoice((s) => s.active);
  const dictation = useDictation((phrase) =>
    setText((prev) => (prev && !prev.endsWith(' ') ? `${prev} ${phrase}` : prev + phrase)),
  );

  // Grow with the content up to a few lines.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const canSend =
    !running &&
    (text.trim().length > 0 || attached !== null || attachedMark !== null || mode !== 'free');
  const submit = () => {
    if (!canSend) return;
    dictation.stop();
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
      {attachedMark && (
        <div
          className="bg-surface-muted flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs"
          data-testid="attached-mark"
        >
          <PenLine size={12} aria-hidden className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t.chat.attachedMark(attachedMark.page)}</p>
            <p className="text-text-muted line-clamp-2">{attachedMark.text || t.chat.markNoText}</p>
          </div>
          <button
            type="button"
            onClick={() => attachMark(null)}
            aria-label={t.chat.removeAttachedMark}
            className="text-text-muted hover:text-text rounded p-0.5"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
      <VoiceBar />
      {dictation.listening && (
        <p className="text-text-muted text-xs italic" aria-live="polite">
          {dictation.interim || t.chat.voice.listening}
        </p>
      )}
      {dictation.error && dictation.error !== 'aborted' && (
        <p role="alert" className="text-danger text-xs">
          {dictation.error === 'not-allowed' ? t.chat.voice.denied : t.chat.voice.error}
        </p>
      )}
      <div className="border-border bg-bg focus-within:border-text flex items-end gap-2 rounded-xl border px-3 py-2">
        <textarea
          id={COMPOSER_ID}
          ref={area}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            attached
              ? t.chat.placeholderSelection
              : attachedMark
                ? t.chat.placeholderMark
                : t.chat.placeholder
          }
          aria-label={t.chat.placeholder}
          className="max-h-40 min-w-0 flex-1 resize-none bg-transparent text-base outline-none focus-visible:outline-none sm:text-sm"
        />
        {canTalk && <VoiceToggle />}
        {canDictate && !voiceMode && (
          <button
            type="button"
            onClick={dictation.toggle}
            aria-label={dictation.listening ? t.chat.voice.stop : t.chat.voice.start}
            title={dictation.listening ? t.chat.voice.stop : t.chat.voice.start}
            aria-pressed={dictation.listening}
            className={clsx(
              'rounded-full p-1.5',
              dictation.listening
                ? 'bg-danger animate-pulse text-white'
                : 'text-text-muted hover:text-text',
            )}
          >
            <Mic size={14} aria-hidden />
          </button>
        )}
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
