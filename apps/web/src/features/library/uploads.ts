import type { DocumentSummary, UploadSession } from '@pdfclaudeassistant/shared';
import { create } from 'zustand';
import { api, ApiError } from '../../lib/api';

export type UploadState = 'waiting' | 'uploading' | 'retrying' | 'done' | 'error' | 'cancelled';

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  topicId: string;
  sent: number;
  state: UploadState;
  /** Server error code when `state === 'error'`. */
  error?: string;
}

interface UploadStore {
  items: UploadItem[];
  add: (files: File[], topicId: string) => void;
  cancel: (key: string) => void;
  dismiss: (key: string) => void;
}

const MAX_ATTEMPTS = 6;
/** Files handled one at a time so a big book does not starve the others of bandwidth. */
const queue: { key: string; file: File }[] = [];
const controllers = new Map<string, AbortController>();
let running = false;
let onUploaded: (doc: DocumentSummary) => void = () => {};

/** Called after each finished upload (the library page refreshes its tree). */
export function setOnUploaded(fn: (doc: DocumentSummary) => void) {
  onUploaded = fn;
}

export const useUploads = create<UploadStore>((set, get) => ({
  items: [],
  add: (files, topicId) => {
    const added = files.map((file) => ({
      key: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      topicId,
      sent: 0,
      state: 'waiting' as const,
    }));
    added.forEach((item, i) => queue.push({ key: item.key, file: files[i]! }));
    set({ items: [...get().items, ...added] });
    void pump();
  },
  cancel: (key) => {
    controllers.get(key)?.abort();
    const i = queue.findIndex((q) => q.key === key);
    if (i >= 0) queue.splice(i, 1);
    patch(key, { state: 'cancelled' });
  },
  dismiss: (key) => set({ items: get().items.filter((i) => i.key !== key) }),
}));

function patch(key: string, p: Partial<UploadItem>) {
  useUploads.setState((s) => ({
    items: s.items.map((i) => (i.key === key ? { ...i, ...p } : i)),
  }));
}

async function pump() {
  if (running) return;
  running = true;
  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const item = useUploads.getState().items.find((i) => i.key === next!.key);
      if (!item || item.state === 'cancelled') continue;
      await uploadFile(next.key, next.file, item.topicId);
    }
  } finally {
    running = false;
  }
}

async function uploadFile(key: string, file: File, topicId: string) {
  const ctrl = new AbortController();
  controllers.set(key, ctrl);
  let session: UploadSession | null = null;
  try {
    session = await api<UploadSession>('/uploads', {
      method: 'POST',
      json: { topicId, filename: file.name, size: file.size },
      signal: ctrl.signal,
    });
    patch(key, { state: 'uploading' });
    let offset = session.received;
    let attempts = 0;
    while (offset < file.size) {
      const end = Math.min(offset + session.chunkSize, file.size);
      try {
        const res = await putChunk(session.id, offset, file.slice(offset, end), ctrl.signal, (n) =>
          patch(key, { sent: offset + n }),
        );
        offset = res.received;
        attempts = 0;
        patch(key, { sent: offset, state: 'uploading' });
      } catch (err) {
        if (ctrl.signal.aborted) throw err;
        if (err instanceof OffsetError) {
          offset = err.received;
          continue;
        }
        // Network errors, 5xx and 409 (previous attempt still finishing) are retried; any
        // other 4xx means the file itself is refused.
        const retryable =
          !(err instanceof ApiError) || err.status === 0 || err.status === 409 || err.status >= 500;
        if (!retryable) throw err;
        if (++attempts >= MAX_ATTEMPTS) throw err;
        patch(key, { state: 'retrying' });
        await sleep(Math.min(30_000, 1000 * 2 ** attempts), ctrl.signal);
        // The server's byte count is authoritative after a network failure.
        offset = (await api<UploadSession>(`/uploads/${session.id}`, { signal: ctrl.signal }))
          .received;
      }
    }
    const doc = await api<DocumentSummary>(`/uploads/${session.id}/complete`, {
      method: 'POST',
      signal: ctrl.signal,
    });
    patch(key, { state: 'done', sent: file.size });
    onUploaded(doc);
  } catch (err) {
    if (ctrl.signal.aborted) {
      if (session) void api(`/uploads/${session.id}`, { method: 'DELETE' }).catch(() => {});
      return;
    }
    patch(key, { state: 'error', error: err instanceof ApiError ? err.code : 'upload_failed' });
  } finally {
    controllers.delete(key);
  }
}

class OffsetError extends Error {
  constructor(readonly received: number) {
    super('offset_mismatch');
  }
}

/** XHR rather than fetch: it reports upload progress within a 32 MB chunk. */
function putChunk(
  id: string,
  offset: number,
  body: Blob,
  signal: AbortSignal,
  onProgress: (sent: number) => void,
): Promise<UploadSession> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/uploads/${id}?offset=${offset}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const res = (xhr.response ?? {}) as { error?: string; received?: number };
      if (xhr.status === 200) resolve(xhr.response as UploadSession);
      else if (xhr.status === 409 && res.error === 'offset_mismatch')
        reject(new OffsetError(res.received ?? 0));
      else reject(new ApiError(xhr.status, res.error ?? 'unknown'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network'));
    signal.addEventListener('abort', () => {
      xhr.abort();
      reject(new DOMException('Aborted', 'AbortError'));
    });
    xhr.send(body);
  });
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}
