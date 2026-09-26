import { z } from 'zod';

const id = z.string().min(1).max(64);

export interface Flashcard {
  id: string;
  documentId: string | null;
  documentTitle: string | null;
  page: number | null;
  conceptId: string | null;
  front: string;
  back: string;
  author: 'user' | 'claude';
  status: 'active' | 'proposed' | 'rejected';
  dueAt: string;
  /** FSRS state: new, learning, review, relearning. */
  state: 'new' | 'learning' | 'review' | 'relearning';
  reps: number;
  lapses: number;
  createdAt: string;
}

/** Rating buttons (F-REV-02): Otra vez / Difícil / Bien / Fácil. */
export const RATINGS = [1, 2, 3, 4] as const;
export type ReviewRating = (typeof RATINGS)[number];

export const createFlashcardsSchema = z.object({
  cards: z
    .array(
      z.object({
        front: z.string().trim().min(1).max(2000),
        back: z.string().trim().min(1).max(4000),
        documentId: id.nullable().optional(),
        page: z.number().int().min(1).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});
export const updateFlashcardSchema = z.object({
  front: z.string().trim().min(1).max(2000).optional(),
  back: z.string().trim().min(1).max(4000).optional(),
  status: z.enum(['active', 'rejected']).optional(),
});
export const reviewSchema = z.object({
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  /** Reviewer's local day (YYYY-MM-DD) for streaks. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export const reviewQuerySchema = z.object({
  subjectId: id.optional(),
  topicId: id.optional(),
  documentId: id.optional(),
});

export interface ReviewQueue {
  due: Flashcard[];
  /** Next intervals per rating for the first due card, e.g. { 1: "1 min", 3: "3 d" }. */
  preview: Record<ReviewRating, string> | null;
  proposed: Flashcard[];
  total: number;
}

export interface DailyBrief {
  day: string;
  dueCount: number;
  concepts: {
    id: string;
    name: string;
    mastery: number;
    documentId: string | null;
    page: number | null;
  }[];
  /** Markdown written by Claude: mini explanations/questions and what to read next. */
  text: string | null;
  continueReading: { id: string; title: string; lastPage: number; progressPct: number } | null;
  generatedAt: string | null;
}

export interface StudyStats {
  streakDays: number;
  studySecondsTotal: number;
  /** Last 30 days: seconds studied, cards reviewed and study-timer focus per day. */
  days: {
    day: string;
    seconds: number;
    reviews: number;
    pomodoros: number;
    focusSeconds: number;
  }[];
  reviewsTotal: number;
  /** Share of reviews not rated "again" in the last 30 days (0–1), null if none. */
  retention: number | null;
  cards: { total: number; due: number; mature: number };
  subjects: {
    id: string;
    name: string;
    color: string;
    progressPct: number;
    seconds: number;
    topics: {
      id: string;
      name: string;
      progressPct: number;
      documents: { id: string; title: string; progressPct: number; seconds: number }[];
    }[];
  }[];
  concepts: { total: number; weak: number; mastered: number; averageMastery: number | null };
  exams: { total: number; correct: number };
  /** Study timer (F-FOCUS-02): completed focus blocks and focused time, cut-short blocks included. */
  focus: { pomodorosTotal: number; pomodorosToday: number; focusSecondsTotal: number };
}
