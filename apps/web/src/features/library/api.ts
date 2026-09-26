import type {
  CreateSubject,
  CreateTopic,
  DocumentStatus,
  LibraryTree,
  SubjectNode,
  TrashedDocument,
  UpdateDocument,
  UpdateSubject,
  UpdateTopic,
} from '@pdfclaudeassistant/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export const libraryKey = ['library'] as const;
export const trashKey = ['trash'] as const;

const PROCESSING: DocumentStatus[] = ['queued', 'ocr', 'indexing'];

export function isProcessing(status: DocumentStatus) {
  return PROCESSING.includes(status);
}

/** Library tree; polls while any document is still being processed (F-ING-05). */
export function useLibrary() {
  return useQuery({
    queryKey: libraryKey,
    queryFn: () => api<LibraryTree>('/library'),
    refetchInterval: (q) => {
      const tree = q.state.data;
      const busy = tree?.subjects.some((s) =>
        s.topics.some((t) => t.documents.some((d) => isProcessing(d.status))),
      );
      return busy ? 2000 : false;
    },
  });
}

export function useTrash() {
  return useQuery({ queryKey: trashKey, queryFn: () => api<TrashedDocument[]>('/trash') });
}

/** Mutation that refreshes the library (and the trash) when it settles. */
function useLibraryMutation<V, R = void>(
  fn: (vars: V) => Promise<R>,
  optimistic?: (tree: LibraryTree, vars: V) => LibraryTree,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onMutate: async (vars) => {
      if (!optimistic) return;
      await qc.cancelQueries({ queryKey: libraryKey });
      const prev = qc.getQueryData<LibraryTree>(libraryKey);
      if (prev) qc.setQueryData(libraryKey, optimistic(prev, vars));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(libraryKey, ctx.prev);
    },
    // Returning the promise makes per-call callbacks (e.g. navigate to a new topic) wait
    // until the refreshed tree is in the cache.
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: libraryKey }),
        qc.invalidateQueries({ queryKey: trashKey }),
      ]),
  });
}

const mapSubjects = (tree: LibraryTree, fn: (s: SubjectNode[]) => SubjectNode[]) => ({
  ...tree,
  subjects: fn(tree.subjects),
});

const byIds = <T extends { id: string }>(items: T[], ids: string[]) =>
  ids.map((id) => items.find((i) => i.id === id)).filter((i): i is T => Boolean(i));

export const useCreateSubject = () =>
  useLibraryMutation((body: CreateSubject) =>
    api<{ id: string }>('/subjects', { method: 'POST', json: body }),
  );

export const useUpdateSubject = () =>
  useLibraryMutation(({ id, ...body }: UpdateSubject & { id: string }) =>
    api(`/subjects/${id}`, { method: 'PATCH', json: body }),
  );

export const useDeleteSubject = () =>
  useLibraryMutation((id: string) => api(`/subjects/${id}`, { method: 'DELETE' }));

export const useReorderSubjects = () =>
  useLibraryMutation(
    (ids: string[]) => api('/subjects/reorder', { method: 'POST', json: { ids } }),
    (tree, ids) => mapSubjects(tree, (s) => byIds(s, ids)),
  );

export const useCreateTopic = () =>
  useLibraryMutation((body: CreateTopic) =>
    api<{ id: string }>('/topics', { method: 'POST', json: body }),
  );

export const useUpdateTopic = () =>
  useLibraryMutation(({ id, ...body }: UpdateTopic & { id: string }) =>
    api(`/topics/${id}`, { method: 'PATCH', json: body }),
  );

export const useDeleteTopic = () =>
  useLibraryMutation((id: string) => api(`/topics/${id}`, { method: 'DELETE' }));

export const useReorderTopics = () =>
  useLibraryMutation(
    ({ ids }: { subjectId: string; ids: string[] }) =>
      api('/topics/reorder', { method: 'POST', json: { ids } }),
    (tree, { subjectId, ids }) =>
      mapSubjects(tree, (subjects) =>
        subjects.map((s) => (s.id === subjectId ? { ...s, topics: byIds(s.topics, ids) } : s)),
      ),
  );

export const useUpdateDocument = () =>
  useLibraryMutation(
    ({ id, ...body }: UpdateDocument & { id: string }) =>
      api(`/documents/${id}`, { method: 'PATCH', json: body }),
    (tree, { id, title, topicId }) => {
      const doc = tree.subjects
        .flatMap((s) => s.topics)
        .flatMap((t) => t.documents)
        .find((d) => d.id === id);
      if (!doc) return tree;
      const updated = { ...doc, ...(title ? { title } : {}), ...(topicId ? { topicId } : {}) };
      return mapSubjects(tree, (subjects) =>
        subjects.map((s) => ({
          ...s,
          topics: s.topics.map((t) => {
            const docs = t.documents.filter((d) => d.id !== id);
            if (t.id === updated.topicId) {
              const at = t.documents.findIndex((d) => d.id === id);
              if (at >= 0) docs.splice(at, 0, updated);
              else docs.push(updated);
            }
            return { ...t, documents: docs };
          }),
        })),
      );
    },
  );

export const useReorderDocuments = () =>
  useLibraryMutation(
    ({ ids }: { topicId: string; ids: string[] }) =>
      api('/documents/reorder', { method: 'POST', json: { ids } }),
    (tree, { topicId, ids }) =>
      mapSubjects(tree, (subjects) =>
        subjects.map((s) => ({
          ...s,
          topics: s.topics.map((t) =>
            t.id === topicId ? { ...t, documents: byIds(t.documents, ids) } : t,
          ),
        })),
      ),
  );

export const useTrashDocument = () =>
  useLibraryMutation((id: string) => api(`/documents/${id}`, { method: 'DELETE' }));

export const useRestoreDocument = () =>
  useLibraryMutation(({ id, topicId }: { id: string; topicId: string }) =>
    api(`/trash/${id}/restore`, { method: 'POST', json: { topicId } }),
  );

export const useEmptyTrash = () => useLibraryMutation(() => api('/trash', { method: 'DELETE' }));

export const usePurgeDocument = () =>
  useLibraryMutation((id: string) => api(`/trash/${id}`, { method: 'DELETE' }));
