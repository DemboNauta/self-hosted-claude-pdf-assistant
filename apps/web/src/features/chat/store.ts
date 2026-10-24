import {
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILES,
  MAX_CHAT_IMAGES,
  markRefs,
  type ChatErrorCode,
  type ChatFile,
  type ChatImage,
  type ChatMessage,
  type ClientChatEvent,
  type DrawingMark,
  type PointedMark,
  type PointerGroup,
  type ServerChatEvent,
  type StudyMode,
  type SummaryFormat,
  type TextSelection,
  type ThreadScope,
  type ThreadSummary,
} from '@pdfclaudeassistant/shared';
import { create } from 'zustand';
import { t } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { imageErrorText, prepareImage } from '../annotations/images';
import { useReader } from '../reader/store';

/** A picture attached to the next question: uploading, ready (`image`) or failed. */
export interface PendingImage {
  key: string;
  /** Local preview while it uploads. */
  previewUrl: string;
  image?: ChatImage;
  error?: string;
}

/** A file (PDF, Word, text) attached to the next question: uploading, ready or failed. */
export interface PendingFile {
  key: string;
  name: string;
  file?: ChatFile;
  error?: string;
}

/** Extensions the attach button offers besides pictures (the server checks the bytes). */
export const CHAT_FILE_ACCEPT = [
  '.pdf',
  '.docx',
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.tex',
  '.html',
  '.css',
  '.js',
  '.ts',
  '.py',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.cs',
  '.go',
  '.rs',
  '.sql',
  '.sh',
  '.m',
  '.r',
].join(',');

/** A failed file upload, in words for the student. */
function fileErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'unsupported_file') return t.chat.files.errors.unsupported;
    if (err.code === 'unreadable_file') return t.chat.files.errors.unreadable;
    if (err.code === 'file_too_large' || err.status === 413) return t.chat.files.errors.tooLarge;
  }
  return t.chat.files.errors.failed;
}

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
  /** One of Claude's marks the student clicked to ask about it. */
  attachedPointed: PointedMark | null;
  /** Pictures (screenshots, photos) attached to the next question. */
  images: PendingImage[];
  /** Files (PDF, Word, text) attached to the next question, for Claude to read. */
  files: PendingFile[];
  /** Why some pictures or files were not attached (e.g. too many). */
  attachNotice: string | null;
  /** Claude's temporary marks on the PDF (F-POINT-03: gone with the next question). */
  pointers: PointerGroup[];
  /** Voice mode (F-CHAT-09): questions ask for a spoken, tutor-style answer. */
  voice: boolean;

  openDocument: (docId: string) => Promise<void>;
  openScope: (scope: ThreadScope) => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  refresh: () => Promise<void>;
  newThread: () => Promise<void>;
  send: (
    text: string,
    opts?: {
      mode?: StudyMode;
      selection?: TextSelection | null;
      mark?: DrawingMark | null;
      /** Voice mode: the last sentence heard before the student cut Claude short. */
      interruptedAfter?: string;
      /** The page the question is about instead of the one on screen (voice mode). */
      page?: number;
      /** Voice mode, podcast style: ask Claude to carry on explaining. */
      continueExplaining?: boolean;
    },
  ) => void;
  stop: () => void;
  setMode: (mode: StudyMode) => void;
  setSummaryFormat: (format: SummaryFormat) => void;
  setDiagramRange: (range: { from: number; to: number } | null) => void;
  attach: (selection: TextSelection | null) => void;
  attachMark: (mark: DrawingMark | null) => void;
  attachPointed: (pointed: PointedMark | null) => void;
  /** Pasted, dropped or chosen pictures: shrunk, uploaded and attached to the next question. */
  addImages: (files: File[]) => void;
  removeImage: (key: string) => void;
  /** Pasted, dropped or chosen files: pictures go with `addImages`, the rest are uploaded. */
  addAttachments: (files: File[]) => void;
  removeFile: (key: string) => void;
  dismissError: () => void;
  clearPointers: (messageId?: string) => void;
  /**
   * Shows the marks of an answer again (a `[[mark:ID]]` chip, or all of them), replacing
   * the ones on screen, and jumps to their page.
   */
  showMarks: (messageId: string, markId?: string) => void;
  setVoice: (on: boolean) => void;
}

const scopePath = (s: ThreadScope) =>
  `/${s.kind === 'document' ? 'documents' : s.kind === 'topic' ? 'topics' : 'subjects'}/${s.id}`;

let pollTimer: ReturnType<typeof setTimeout> | undefined;

/** Drops the pictures and files attached to the next question (sent, or the chat changed). */
function clearImages() {
  for (const img of useChat.getState().images) URL.revokeObjectURL(img.previewUrl);
  useChat.setState({ images: [], files: [], attachNotice: null });
}

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
  attachedPointed: null,
  images: [],
  files: [],
  attachNotice: null,
  pointers: [],
  voice: false,

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
      attachedPointed: null,
      pointers: [],
    });
    clearImages();
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
    const pointed = get().attachedPointed;
    const mode = opts.mode ?? get().mode;
    // Pictures still uploading would be lost: the composer waits for them.
    if (
      get().images.some((i) => !i.image && !i.error) ||
      get().files.some((f) => !f.file && !f.error)
    )
      return;
    const images = get().images.flatMap((i) => (i.image ? [i.image] : []));
    const files = get().files.flatMap((f) => (f.file ? [f.file] : []));
    const clientId = crypto.randomUUID();
    const context = {
      ...(scope.kind === 'document'
        ? { docId: scope.id, currentPage: opts.page ?? useReader.getState().currentPage }
        : scope.kind === 'topic'
          ? { topicId: scope.id }
          : { subjectId: scope.id }),
      ...(selection ? { selection } : {}),
      ...(mark && scope.kind === 'document' ? { mark } : {}),
      ...(pointed && !selection && !mark && scope.kind === 'document' ? { pointed } : {}),
      ...(mode === 'summary' ? { summaryFormat: get().summaryFormat } : {}),
      ...(mode === 'diagram' && !selection && scope.kind === 'document' && get().diagramRange
        ? { pageRange: get().diagramRange! }
        : {}),
      ...(get().voice ? { voice: true } : {}),
      ...(opts.interruptedAfter ? { interruptedAfter: opts.interruptedAfter.slice(0, 2000) } : {}),
      ...(opts.continueExplaining ? { continueExplaining: true } : {}),
    };
    const optimistic: ChatMessage = {
      id: clientId,
      threadId,
      role: 'user',
      content: text,
      mode,
      context,
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
      status: 'complete',
      createdAt: new Date().toISOString(),
    };
    set({
      messages: [...get().messages, optimistic],
      running: true,
      error: null,
      attached: null,
      attachedMark: null,
      attachedPointed: null,
      pointers: [],
    });
    clearImages();
    chatSocket.send({
      type: 'user_message',
      threadId,
      clientId,
      text,
      mode,
      context,
      imageIds: images.map((i) => i.id),
      fileIds: files.map((f) => f.id),
    });
  },

  stop: () => {
    const threadId = get().threadId;
    if (threadId) chatSocket.send({ type: 'stop', threadId });
  },

  setMode: (mode) => set({ mode }),
  setSummaryFormat: (summaryFormat) => set({ summaryFormat }),
  setDiagramRange: (diagramRange) => set({ diagramRange }),
  attach: (attached) =>
    set({ attached, ...(attached ? { attachedMark: null, attachedPointed: null } : {}) }),
  attachMark: (attachedMark) =>
    set({ attachedMark, ...(attachedMark ? { attached: null, attachedPointed: null } : {}) }),
  attachPointed: (attachedPointed) =>
    set({ attachedPointed, ...(attachedPointed ? { attached: null, attachedMark: null } : {}) }),
  addImages: (files) => {
    const room = MAX_CHAT_IMAGES - get().images.length;
    set({ attachNotice: files.length > room ? t.chat.images.tooMany(MAX_CHAT_IMAGES) : null });
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      const update = (patch: Partial<PendingImage>) =>
        set({ images: get().images.map((i) => (i.key === key ? { ...i, ...patch } : i)) });
      set({ images: [...get().images, { key, previewUrl: URL.createObjectURL(file) }] });
      void prepareImage(file)
        .then((dataUrl) => api<ChatImage>('/chat-images', { method: 'POST', json: { dataUrl } }))
        .then((image) => update({ image }))
        .catch((err: unknown) => update({ error: imageErrorText(err) }));
    }
  },
  addAttachments: (all) => {
    const pictures = all.filter((f) => f.type.startsWith('image/'));
    if (pictures.length) get().addImages(pictures);
    const docs = all.filter((f) => !f.type.startsWith('image/'));
    if (!docs.length) return;
    const room = MAX_CHAT_FILES - get().files.length;
    if (docs.length > room) set({ attachNotice: t.chat.files.tooMany(MAX_CHAT_FILES) });
    else if (!pictures.length) set({ attachNotice: null });
    for (const doc of docs.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      const update = (patch: Partial<PendingFile>) =>
        set({ files: get().files.map((f) => (f.key === key ? { ...f, ...patch } : f)) });
      set({ files: [...get().files, { key, name: doc.name }] });
      if (doc.size > MAX_CHAT_FILE_BYTES) {
        update({ error: t.chat.files.errors.tooLarge });
        continue;
      }
      void api<ChatFile>('/chat-files', {
        method: 'POST',
        body: doc,
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(doc.name),
        },
      })
        .then((file) => update({ file }))
        .catch((err: unknown) => update({ error: fileErrorText(err) }));
    }
  },
  removeFile: (key) => set({ files: get().files.filter((f) => f.key !== key), attachNotice: null }),
  removeImage: (key) => {
    const img = get().images.find((i) => i.key === key);
    if (img) URL.revokeObjectURL(img.previewUrl);
    set({ images: get().images.filter((i) => i.key !== key), attachNotice: null });
  },
  dismissError: () => set({ error: null }),
  setVoice: (voice) => set({ voice }),
  clearPointers: (messageId) =>
    set({ pointers: messageId ? get().pointers.filter((g) => g.messageId !== messageId) : [] }),
  showMarks: (messageId, markId) => {
    const groups = (get().messages.find((m) => m.id === messageId)?.pointers ?? []).filter(
      (g) => !markId || g.id === markId,
    );
    if (!groups.length) return;
    for (const g of groups) revealed.add(`${messageId}:${g.id}`);
    set({ pointers: groups });
    // The student asked for them: go there whatever "seguir a Claude" says.
    const g = groups[0]!;
    const reader = useReader.getState();
    if (g.docId === reader.docId) reader.goTo(g.page);
    else if (reader.side?.docId === g.docId) reader.setSidePage(g.page);
    else reader.setOffer({ docId: g.docId, page: g.page });
  },
}));

/**
 * Marks already shown on their own, by `messageId:markId`: each one appears once as the
 * answer reaches it (and stays gone if the student dismisses it); chips show it again.
 */
const revealed = new Set<string>();

type BoardRevealer = (messageId: string, ids: string[] | null, exclude?: Set<string>) => void;
let boardRevealer: BoardRevealer = () => {};
/** The whiteboard registers how it draws Claude's steps when the answer reaches them. */
export function setBoardRevealer(fn: BoardRevealer) {
  boardRevealer = fn;
}

/**
 * Brings a page Claude refers to into view (F-POINT-05): with "seguir a Claude" on the
 * reader (or the split view showing that document) moves there; otherwise the student
 * gets a button to go (owner's choice).
 */
function navigateTo(target: { docId: string; page: number; quote?: string; side?: boolean }) {
  const reader = useReader.getState();
  const { docId, page, quote, side } = target;
  if (side) {
    if (reader.follow && window.matchMedia('(min-width: 1024px)').matches) {
      reader.openSide(docId, page);
    } else reader.setOffer({ docId, page, side: true });
    return;
  }
  if (reader.side?.docId === docId && reader.side.docId !== reader.docId) {
    if (reader.side.page !== page) reader.setSidePage(page);
    return;
  }
  if (docId === reader.docId && reader.currentPage === page && !quote) return;
  if (reader.follow && docId === reader.docId) reader.goTo(page, quote);
  else reader.setOffer({ docId, page, ...(quote && { quote }) });
}

function jumpTo(group: PointerGroup) {
  navigateTo({ docId: group.docId, page: group.page });
}

/**
 * Shows marks of an answer that have not been shown yet: the ones it references
 * (`ids`), or with `ids` absent the deferred ones it never referenced.
 */
export function revealMarks(messageId: string, ids?: string[]) {
  const s = useChat.getState();
  const message = s.messages.find((m) => m.id === messageId);
  if (!message) return;
  const referenced = ids ? null : new Set(markRefs(message.content));
  // Whiteboard steps (`w…`) are drawn by the board.
  const boardIds = ids?.filter((id) => id.startsWith('w'));
  if (!ids || boardIds?.length) boardRevealer(messageId, boardIds ?? null, referenced ?? undefined);
  if (!message.pointers?.length) return;
  const fresh = message.pointers.filter(
    (g) =>
      !revealed.has(`${messageId}:${g.id}`) && (ids ? ids.includes(g.id) : !referenced!.has(g.id)),
  );
  if (!fresh.length) return;
  for (const g of fresh) revealed.add(`${messageId}:${g.id}`);
  useChat.setState({ pointers: [...s.pointers.filter((p) => !fresh.includes(p)), ...fresh] });
  jumpTo(fresh[fresh.length - 1]!);
}

/** Written answers show their marks as the text reaches them; voice mode as it is spoken. */
function revealWritten(messageId: string) {
  const s = useChat.getState();
  if (s.voice) return;
  const message = s.messages.find((m) => m.id === messageId);
  if (message) revealMarks(messageId, markRefs(message.content));
}

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
      if (event.text.includes(']]')) revealWritten(event.messageId);
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
      // Marks never referenced in the answer show at its end.
      revealWritten(event.message.id);
      revealMarks(event.message.id);
      if (s.scope) {
        const scope = s.scope;
        void api<ThreadSummary[]>(`${scopePath(scope)}/threads`).then((threads) => {
          if (useChat.getState().scope === scope) useChat.setState({ threads });
        });
      }
      break;
    case 'pointer': {
      const { group } = event;
      useChat.setState({
        messages: s.messages.map((m) =>
          m.id === group.messageId ? { ...m, pointers: [...(m.pointers ?? []), group] } : m,
        ),
      });
      if (!group.deferred) revealMarks(group.messageId, [group.id]);
      else revealWritten(group.messageId);
      break;
    }
    case 'clear_pointers':
      useChat.setState({ pointers: [] });
      break;
    case 'navigate':
      navigateTo(event);
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
