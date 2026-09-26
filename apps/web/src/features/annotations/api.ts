import {
  CLAUDE_COLOR,
  CLAUDE_COLOR_KEY,
  DEFAULT_PALETTE,
  type Annotation,
  type AnnotationDisplay,
  type AppSettings,
  type CreateAnnotation,
  type UpdateAnnotation,
} from '@pdfclaudeassistant/shared';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from '../../lib/api';
import { queryClient } from '../../lib/queryClient';

export const annotationsKey = (docId: string) => ['annotations', docId] as const;
export const settingsKey = ['settings'] as const;

export function useAnnotations(docId: string | null) {
  return useQuery({
    queryKey: annotationsKey(docId ?? ''),
    queryFn: () => api<Annotation[]>(`/documents/${docId}/annotations`),
    enabled: Boolean(docId),
  });
}

export function useSettings() {
  return useQuery({ queryKey: settingsKey, queryFn: () => api<AppSettings>('/settings') });
}

/** Palette colours by key, with Claude's orange and hex passthrough. */
export function usePalette() {
  const palette = useSettings().data?.palette ?? DEFAULT_PALETTE;
  const colorOf = (key: string) =>
    key === CLAUDE_COLOR_KEY
      ? CLAUDE_COLOR
      : (palette.find((p) => p.key === key)?.color ?? (key.startsWith('#') ? key : '#f7d33d'));
  return { palette, colorOf };
}

// ---- mutations with undo/redo (F-ANN-08) ---------------------------------

interface Command {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

interface HistoryState {
  docId: string | null;
  past: Command[];
  future: Command[];
  busy: boolean;
}

export const useAnnotationHistory = create<HistoryState>(() => ({
  docId: null,
  past: [],
  future: [],
  busy: false,
}));

const LIMIT = 100;

function refresh(docId: string) {
  return queryClient.invalidateQueries({ queryKey: annotationsKey(docId) });
}

function setCache(docId: string, fn: (list: Annotation[]) => Annotation[]) {
  queryClient.setQueryData<Annotation[]>(annotationsKey(docId), (old) => fn(old ?? []));
}

function push(docId: string, cmd: Command) {
  const h = useAnnotationHistory.getState();
  const past = h.docId === docId ? h.past : [];
  useAnnotationHistory.setState({ docId, past: [...past, cmd].slice(-LIMIT), future: [] });
}

async function run(fn: () => Promise<void>) {
  useAnnotationHistory.setState({ busy: true });
  try {
    await fn();
  } finally {
    useAnnotationHistory.setState({ busy: false });
  }
}

export async function undo() {
  const { past, future, busy } = useAnnotationHistory.getState();
  const cmd = past.at(-1);
  if (!cmd || busy) return;
  await run(cmd.undo);
  useAnnotationHistory.setState({ past: past.slice(0, -1), future: [...future, cmd] });
}

export async function redo() {
  const { past, future, busy } = useAnnotationHistory.getState();
  const cmd = future.at(-1);
  if (!cmd || busy) return;
  await run(cmd.redo);
  useAnnotationHistory.setState({ future: future.slice(0, -1), past: [...past, cmd] });
}

const post = (docId: string, items: CreateAnnotation[], ids?: string[]) =>
  api<Annotation[]>(`/documents/${docId}/annotations`, {
    method: 'POST',
    json: ids ? { items, ids } : { items },
  });

const remove = (ids: string[]) => api('/annotations/delete', { method: 'POST', json: { ids } });

/** Annotation → the payload that recreates it (undo of a delete). */
function toCreate(a: Annotation): CreateAnnotation {
  return {
    type: a.type,
    page: a.page,
    color: a.color,
    content: a.content,
    display: a.display,
    anchor: a.anchor,
  } as CreateAnnotation;
}

export async function createAnnotations(docId: string, items: CreateAnnotation[]) {
  const created = await post(docId, items);
  setCache(docId, (list) => [...list, ...created]);
  const ids = created.map((a) => a.id);
  push(docId, {
    undo: async () => {
      await remove(ids);
      await refresh(docId);
    },
    redo: async () => {
      await post(docId, items, ids);
      await refresh(docId);
    },
  });
  return created;
}

export async function deleteAnnotations(docId: string, items: Annotation[]) {
  const ids = items.map((a) => a.id);
  setCache(docId, (list) => list.filter((a) => !ids.includes(a.id)));
  await remove(ids);
  push(docId, {
    undo: async () => {
      await post(docId, items.map(toCreate), ids);
      // Restored proposals keep their state.
      const proposed = items.filter((a) => a.status !== 'active').map((a) => a.id);
      if (proposed.length) {
        await api('/annotations/status', {
          method: 'POST',
          json: { ids: proposed, status: 'proposed' },
        });
      }
      await refresh(docId);
    },
    redo: async () => {
      await remove(ids);
      await refresh(docId);
    },
  });
}

export async function updateAnnotation(docId: string, before: Annotation, patch: UpdateAnnotation) {
  const reverse: UpdateAnnotation = {};
  if (patch.color !== undefined) reverse.color = before.color;
  if (patch.content !== undefined) reverse.content = before.content;
  if (patch.anchor !== undefined) reverse.anchor = before.anchor;
  if (patch.status !== undefined) reverse.status = before.status;
  const apply = async (p: UpdateAnnotation) => {
    const updated = await api<Annotation>(`/annotations/${before.id}`, {
      method: 'PATCH',
      json: p,
    });
    setCache(docId, (list) => list.map((a) => (a.id === updated.id ? updated : a)));
  };
  await apply(patch);
  push(docId, { undo: () => apply(reverse), redo: () => apply(patch) });
}

/**
 * Pins, moves or resizes an annotation's note window. Window placement is not an edit
 * of the annotation, so it stays out of the undo history.
 */
export async function updateDisplay(docId: string, id: string, display: AnnotationDisplay | null) {
  setCache(docId, (list) => list.map((a) => (a.id === id ? { ...a, display } : a)));
  await api<Annotation>(`/annotations/${id}`, { method: 'PATCH', json: { display } });
}

/** Accept or discard Claude's proposals (F-ANN-04), undoable as one step. */
export async function setProposalStatus(
  docId: string,
  ids: string[],
  status: 'active' | 'rejected',
) {
  const apply = async (s: 'active' | 'rejected' | 'proposed') => {
    await api('/annotations/status', { method: 'POST', json: { ids, status: s } });
    await refresh(docId);
  };
  setCache(docId, (list) =>
    status === 'rejected'
      ? list.filter((a) => !ids.includes(a.id))
      : list.map((a) => (ids.includes(a.id) ? { ...a, status } : a)),
  );
  await apply(status);
  push(docId, { undo: () => apply('proposed'), redo: () => apply(status) });
}
