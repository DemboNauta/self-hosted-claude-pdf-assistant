/** Memory categories Claude can write (F-MEM-01/02). */
export const MEMORY_CATEGORIES = [
  'preference',
  'study_habit',
  'difficulty',
  'understood',
  'pending',
  'progress',
  'other',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface MemoryItem {
  id: string;
  scope: 'global' | 'document';
  documentId: string | null;
  documentTitle: string | null;
  category: MemoryCategory;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface Concept {
  id: string;
  name: string;
  documentId: string | null;
  documentTitle: string | null;
  page: number | null;
  /** 0 = not mastered, 1 = mastered. */
  mastery: number;
  timesFailed: number;
  lastEvidence: string | null;
  lastSeenAt: string;
}

/** "Lo que Claude sabe de ti" (F-MEM-05), read-only in the UI. */
export interface MemoryOverview {
  global: MemoryItem[];
  documents: MemoryItem[];
  concepts: Concept[];
}
