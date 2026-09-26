import type {
  ChatErrorCode,
  ChatMessage,
  ClientChatEvent,
  DrawingMark,
  PointerGroup,
  ServerChatEvent,
  StudyMode,
  SummaryFormat,
  TextSelection,
  ThreadScope,
  ThreadSummary,
} from '@pdfclaudeassistant/shared';
import { create } from 'zustand';
import { api } from '../../lib/api';
import { useReader } from '../reader/store';

type Listener = (event: ServerChatEvent) => void;

/**
 * Single WebSocket to `/ws/chat`, reconnected with backoff. Messages sent while it is
 * connecting are queued. Other features (pointers, memory) subscribe to its events.
 */
class ChatSocket {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private retry = 0;
  private listeners = new Set<Listener>();
  private closedByUs = false;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  send(event: ClientChatEvent) {
    const data = JSON.stringify(event);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else {
      this.queue.push(data);
      this.connect();
    }
  }

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.closedByUs = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/chat`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      useChat.setState({ connected: true });
      for (const data of this.queue.splice(0)) ws.send(data);
    };
    ws.onmessage = (e) => {
      const event = JSON.parse(String(e.data)) as ServerChatEvent;
      for (const fn of this.listeners) fn(event);
    };
    ws.onclose = () => {
      useChat.setState({ connected: false });
      this.ws = null;
      if (this.closedByUs) return;
      const delay = Math.min(15_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
      // A turn may have finished while we were disconnected: reload the thread.
      void useChat.getState().refresh();
    };
  }

  /** Closes the socket for good (logout): it belongs to the account that opened it. */
  close() {
    this.closedByUs = true;
    this.queue = [];
    this.ws?.close();
  }
}

export const chatSocket = new ChatSocket();

export interface ChatError {
  code: ChatErrorCode;
  message?: string;
}

interface ChatState {
  /** What the open conversation is about (document, topic or subject). */
  scope: ThreadScope | null;
  threadId: string | null;
  threads: ThreadSummary[];
  messages: ChatMessage[];
  running: boolean;
  connected: boolean;
  error: ChatError | null;
  mode: StudyMode;
  summaryFormat: SummaryFormat;
  /** Pages of the next diagram ("Esquema visual"); null = the whole document. */
  diagramRange: { from: number; to: number } | null;
  /** Selection attached to the next question ("Preguntar" in the selection menu). */
  attached: TextSelection | null;
  /** Area marked with drawings, attached to the next question (instead of a selection). */
  attachedMark: DrawingMark | null;
  /** Claude's temporary marks on the PDF (F-POINT-03: gone with the next question). */
  pointers: PointerGroup[];

  openDocument: (docId: string) => Promise<void>;
  openScope: (scope: ThreadScope) => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  refresh: () => Promise<void>;
  newThread: () => Promise<void>;
  send: (
    text: string,
    opts?: { mode?: StudyMode; selection?: TextSelection | null; mark?: DrawingMark | null },
  ) => void;
  stop: () => void;
  setMode: (mode: StudyMode) => void;
  setSummaryFormat: (format: SummaryFormat) => void;
  setDiagramRange: (range: { from: number; to: number } | null) => void;
  attach: (selection: TextSelection | null) => void;
  attachMark: (mark: DrawingMark | null) => void;
  dismissError: () => void;
  clearPointers: (messageId?: string) => void;
}

const scopePath = (s: ThreadScope) =>
  `/${s.kind === 'document' ? 'documents' : s.kind === 'topic' ? 'topics' : 'subjects'}/${s.id}`;

let pollTimer: ReturnType<typeof setTimeout> | undefined;

export const useChat = create<ChatState>((set, get) => ({
  scope: null,
  threadId: null,
  threads: [],
  messages: [],
  running: false,
  connected: false,
  error: null,
  mode: 'free',
  summaryFormat: 'outline',
  diagramRange: null,
  attached: null,
  attachedMark: null,
  pointers: [],

  openDocument: (docId) => get().openScope({ kind: 'document', id: docId }),

  openScope: async (scope) => {
    const cur = get().scope;
    if (cur?.kind === scope.kind && cur.id === scope.id && get().threadId) return;
    set({
      scope,
      threadId: null,
      messages: [],
      threads: [],
      error: null,
      attached: null,
      attachedMark: null,
      pointers: [],
    });
    chatSocket.connect();
    const active = await api<ThreadSummary>(`${scopePath(scope)}/threads/active`);
    if (get().scope !== scope) return;
    await get().openThread(active.id);
  },

  openThread: async (threadId) => {
    set({ threadId, messages: [], error: null });
    await get().refresh();
    const scope = get().scope;
    if (scope) {
      const threads = await api<ThreadSummary[]>(`${scopePath(scope)}/threads`);
      if (get().scope === scope) set({ threads });
    }
  },

  refresh: async () => {
    const threadId = get().threadId;
    if (!threadId) return;
    const res = await api<{ running: boolean; messages: ChatMessage[] }>(
      `/threads/${threadId}/messages`,
    );
    if (get().threadId !== threadId) return;
    set({ messages: res.messages, running: res.running });
    // The turn streams to another connection (e.g. before a reload): poll until it ends.
    clearTimeout(pollTimer);
    if (res.running) pollTimer = setTimeout(() => void get().refresh(), 2000);
  },

  newThread: async () => {
    const scope = get().scope;
    if (!scope) return;
    const thread = await api<ThreadSummary>(`${scopePath(scope)}/threads`, { method: 'POST' });
    set({ threads: [thread, ...get().threads] });
    await get().openThread(thread.id);
  },

  send: (text, opts = {}) => {
    const { threadId, scope, running } = get();
    if (!threadId || !scope || running) return;
    const selection = opts.selection === undefined ? get().attached : opts.selection;
    const mark = opts.mark === undefined ? get().attachedMark : opts.mark;
    const mode = opts.mode ?? get().mode;
    const clientId = crypto.randomUUID();
    const context = {
      ...(scope.kind === 'document'
        ? { docId: scope.id, currentPage: useReader.getState().currentPage }
        : scope.kind === 'topic'
          ? { topicId: scope.id }
          : { subjectId: scope.id }),
      ...(selection ? { selection } : {}),
      ...(mark && scope.kind === 'document' ? { mark } : {}),
      ...(mode === 'summary' ? { summaryFormat: get().summaryFormat } : {}),
      ...(mode === 'diagram' && !selection && scope.kind === 'document' && get().diagramRange
        ? { pageRange: get().diagramRange! }
        : {}),
    };
    const optimistic: ChatMessage = {
      id: clientId,
      threadId,
      role: 'user',
      content: text,
      mode,
      context,
      status: 'complete',
      createdAt: new Date().toISOString(),
    };
    set({
      messages: [...get().messages, optimistic],
      running: true,
      error: null,
      attached: null,
      attachedMark: null,
      pointers: [],
    });
    chatSocket.send({ type: 'user_message', threadId, clientId, text, mode, context });
  },

  stop: () => {
    const threadId = get().threadId;
    if (threadId) chatSocket.send({ type: 'stop', threadId });
  },

  setMode: (mode) => set({ mode }),
  setSummaryFormat: (summaryFormat) => set({ summaryFormat }),
  setDiagramRange: (diagramRange) => set({ diagramRange }),
  attach: (attached) => set({ attached, ...(attached ? { attachedMark: null } : {}) }),
  attachMark: (attachedMark) => set({ attachedMark, ...(attachedMark ? { attached: null } : {}) }),
  dismissError: () => set({ error: null }),
  clearPointers: (messageId) =>
    set({ pointers: messageId ? get().pointers.filter((g) => g.messageId !== messageId) : [] }),
}));

function upsert(messages: ChatMessage[], message: ChatMessage, replaceId = message.id) {
  const i = messages.findIndex((m) => m.id === replaceId);
  if (i < 0) return [...messages, message];
  const next = messages.slice();
  next[i] = message;
  return next;
}

chatSocket.subscribe((event) => {
  const s = useChat.getState();
  const threadId =
    'threadId' in event
      ? event.threadId
      : event.type === 'user_message'
        ? event.message.threadId
        : undefined;
  if (threadId && threadId !== s.threadId) return;

  switch (event.type) {
    case 'user_message':
      useChat.setState({ messages: upsert(s.messages, event.message, event.clientId) });
      break;
    case 'assistant_start':
      useChat.setState({ messages: upsert(s.messages, event.message), running: true });
      break;
    case 'assistant_delta':
      useChat.setState({
        messages: s.messages.map((m) =>
          m.id === event.messageId ? { ...m, content: m.content + event.text } : m,
        ),
      });
      break;
    case 'tool_event':
      useChat.setState({
        messages: s.messages.map((m) => {
          if (m.id !== event.messageId) return m;
          const events = m.toolEvents ?? [];
          const i = events.findIndex((e) => e.id === event.event.id);
          const next =
            i < 0 ? [...events, event.event] : events.map((e, j) => (j === i ? event.event : e));
          return { ...m, toolEvents: next };
        }),
      });
      break;
    case 'assistant_done':
      useChat.setState({ messages: upsert(s.messages, event.message), running: false });
      if (s.scope) {
        const scope = s.scope;
        void api<ThreadSummary[]>(`${scopePath(scope)}/threads`).then((threads) => {
          if (useChat.getState().scope === scope) useChat.setState({ threads });
        });
      }
      break;
    case 'pointer': {
      useChat.setState({ pointers: [...s.pointers, event.group] });
      // Jump to the page Claude points at (F-POINT-05), unless the reader is already there.
      const reader = useReader.getState();
      if (event.group.docId === reader.docId && reader.currentPage !== event.group.page) {
        reader.goTo(event.group.page);
      }
      break;
    }
    case 'clear_pointers':
      useChat.setState({ pointers: [] });
      break;
    case 'error':
      useChat.setState({
        error: { code: event.code, message: event.message },
        running: event.code === 'busy' ? s.running : false,
      });
      break;
    default:
      break;
  }
});
