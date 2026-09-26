import type { DailyBrief, Flashcard, ReviewQueue, StudyStats } from '@pdfclaudeassistant/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryClient } from '../../lib/queryClient';

/** The viewer's local calendar day (streaks and daily brief follow the user's clock). */
export function localDay(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface ReviewFilter {
  subjectId?: string;
  topicId?: string;
}

const qs = (f: ReviewFilter) =>
  new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();

export const queueKey = (f: ReviewFilter) => ['review-queue', f] as const;

export function useQueue(filter: ReviewFilter) {
  return useQuery({
    queryKey: queueKey(filter),
    queryFn: () => api<ReviewQueue>(`/review/queue?${qs(filter)}`),
  });
}

export function useBrief() {
  const day = localDay();
  return useQuery({
    queryKey: ['brief', day],
    queryFn: () => api<DailyBrief>(`/review/today?day=${day}`),
  });
}

export async function generateBrief() {
  const day = localDay();
  const brief = await api<DailyBrief>(`/review/today?day=${day}`, { method: 'POST' });
  queryClient.setQueryData(['brief', day], brief);
  return brief;
}

export function useStats() {
  const day = localDay();
  return useQuery({
    queryKey: ['stats', day],
    queryFn: () => api<StudyStats>(`/stats?day=${day}`),
  });
}

export function invalidateReview() {
  void queryClient.invalidateQueries({ queryKey: ['review-queue'] });
  void queryClient.invalidateQueries({ queryKey: ['brief'] });
  void queryClient.invalidateQueries({ queryKey: ['stats'] });
}

export async function rate(card: Flashcard, rating: 1 | 2 | 3 | 4) {
  await api(`/flashcards/${card.id}/review`, { method: 'POST', json: { rating, day: localDay() } });
}

export async function createCards(
  cards: { front: string; back: string; documentId?: string; page?: number }[],
) {
  const created = await api<Flashcard[]>('/flashcards', { method: 'POST', json: { cards } });
  invalidateReview();
  return created;
}

export async function updateCard(
  id: string,
  patch: { front?: string; back?: string; status?: 'active' | 'rejected' },
) {
  await api(`/flashcards/${id}`, { method: 'PATCH', json: patch });
  invalidateReview();
}

export async function deleteCard(id: string) {
  await api(`/flashcards/${id}`, { method: 'DELETE' });
  invalidateReview();
}
