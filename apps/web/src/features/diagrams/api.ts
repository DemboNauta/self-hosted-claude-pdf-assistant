import type { Diagram } from '@pdfclaudeassistant/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryClient } from '../../lib/queryClient';

/** Every diagram query starts with this key, so one invalidation refreshes them all. */
export const diagramsKey = ['diagrams'] as const;

export function useDiagram(id: string) {
  return useQuery({
    queryKey: [...diagramsKey, 'one', id],
    queryFn: () => api<Diagram>(`/diagrams/${id}`),
  });
}

export function useDocumentDiagrams(docId: string) {
  return useQuery({
    queryKey: [...diagramsKey, 'doc', docId],
    queryFn: () => api<Diagram[]>(`/documents/${docId}/diagrams`),
  });
}

export function useAllDiagrams() {
  return useQuery({
    queryKey: [...diagramsKey, 'all'],
    queryFn: () => api<Diagram[]>('/diagrams'),
  });
}

export const refreshDiagrams = () => queryClient.invalidateQueries({ queryKey: diagramsKey });

export async function deleteDiagram(id: string) {
  await api(`/diagrams/${id}`, { method: 'DELETE' });
  await refreshDiagrams();
}

export async function renameDiagram(id: string, title: string) {
  await api(`/diagrams/${id}`, { method: 'PATCH', json: { title } });
  await refreshDiagrams();
}
