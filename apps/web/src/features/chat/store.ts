import type {
  ChatErrorCode,
  ChatMessage,
  ClientChatEvent,
  ServerChatEvent,
  StudyMode,
  SummaryFormat,
  TextSelection,
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

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }
}

export const chatSocket = new ChatSocket();

export interface ChatError {
  code: ChatErrorCode;
  message?: string;
}

interface ChatState {
  docId: string | null;
  threadId: string | null;
  threads: ThreadSummary[];
  messages: ChatMessage[];
  running: boolean;
  connected: boolean;
  error: ChatError | null;
  mode: StudyMode;
  summaryFormat: SummaryFormat;
  /** Selection attached to the next question ("Preguntar" in the selection menu). */
  attached: TextSelection | null;

  openDocument: (docId: string) => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  refresh: () => Promise<void>;
  newThread: () => Promise<void>;
  send: (text: string, opts?: { mode?: StudyMode; selection?: TextSelection | null }) => void;
  stop: () => void;
  setMode: (mode: StudyMode) => void;
  setSummaryFormat: (format: SummaryFormat) => void;
  attach: (selection: TextSelection | null) => void;
  dismissError: () => void;
}

let pollTimer: ReturnType<typeof setTimeout> | undefined;

export const useChat = create<ChatState>((set, get) => ({
  docId: null,
  threadId: null,
  threads: [],
  messages: [],
  running: false,
  connected: false,
  error: null,
  mode: 'free',
  summaryFormat: 'outline',
  attached: null,

  openDocument: async (docId) => {
    if (get().docId === docId && get().threadId) return;
    set({ docId, threadId: null, messages: [], threads: [], error: null, attached: null });
    chatSocket.connect();
    const active = await api<ThreadSummary>(`/documents/${docId}/threads/active`);
    if (get().docId !== docId) return;
    await get().openThread(active.id);
  },

  openThread: async (threadId) => {
    set({ threadId, messages: [], error: null });
    await get().refresh();
    const docId = get().docId;
    if (docId) {
      const threads = await api<ThreadSummary[]>(`/documents/${docId}/threads`);
      if (get().docId === docId) set({ threads });
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
    const docId = get().docId;
    if (!docId) return;
    const thread = await api<ThreadSummary>(`/documents/${docId}/threads`, { method: 'POST' });
    set({ threads: [thread, ...get().threads] });
    await get().openThread(thread.id);
  },

  send: (text, opts = {}) => {
    const { threadId, docId, running } = get();
    if (!threadId || !docId || running) return;
    const selection = opts.selection === undefined ? get().attached : opts.selection;
    const mode = opts.mode ?? get().mode;
    const clientId = crypto.randomUUID();
    const context = {
      docId,
      currentPage: useReader.getState().currentPage,
      ...(selection ? { selection } : {}),
      ...(mode === 'summary' ? { summaryFormat: get().summaryFormat } : {}),
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
    set({ messages: [...get().messages, optimistic], running: true, error: null, attached: null });
    chatSocket.send({ type: 'user_message', threadId, clientId, text, mode, context });
  },

  stop: () => {
    const threadId = get().threadId;
    if (threadId) chatSocket.send({ type: 'stop', threadId });
  },

  setMode: (mode) => set({ mode }),
  setSummaryFormat: (summaryFormat) => set({ summaryFormat }),
  attach: (attached) => set({ attached }),
  dismissError: () => set({ error: null }),
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
      void api<ThreadSummary[]>(`/documents/${s.docId}/threads`).then((threads) => {
        if (useChat.getState().docId === s.docId) useChat.setState({ threads });
      });
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
