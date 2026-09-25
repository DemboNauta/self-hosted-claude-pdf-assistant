import { z } from 'zod';

const id = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(200);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * Server-side processing stage (F-ING-05). "Uploading" is client-side only.
 * `ocr` is used from Phase 2 on.
 */
export type DocumentStatus = 'queued' | 'ocr' | 'indexing' | 'ready' | 'error';

export interface DocumentSummary {
  id: string;
  topicId: string | null;
  title: string;
  pageCount: number | null;
  status: DocumentStatus;
  error: string | null;
  progressPct: number;
  lastPage: number;
  lastOpenedAt: string | null;
  createdAt: string;
  hasCover: boolean;
}

export interface TopicNode {
  id: string;
  subjectId: string;
  name: string;
  position: number;
  documents: DocumentSummary[];
}

export interface SubjectNode {
  id: string;
  name: string;
  color: string;
  position: number;
  topics: TopicNode[];
}

export interface LibraryTree {
  subjects: SubjectNode[];
}

export interface PageSize {
  width: number;
  height: number;
}

export interface DocumentDetail extends DocumentSummary {
  lastScroll: number;
  subjectId: string | null;
  topicName: string | null;
  subjectName: string | null;
  /** Page sizes in PDF points, index 0 = page 1. Lets the viewer lay out before rendering. */
  pageSizes: PageSize[];
}

export interface TrashedDocument {
  id: string;
  title: string;
  deletedAt: string;
  purgeAt: string;
  /** Topic it was in, if that topic still exists (restore target suggestion). */
  originalTopicId: string | null;
}

export const createSubjectSchema = z.object({ name, color: hexColor.optional() });
export const updateSubjectSchema = z.object({ name: name.optional(), color: hexColor.optional() });
export const createTopicSchema = z.object({ subjectId: id, name });
export const updateTopicSchema = z.object({ name: name.optional(), subjectId: id.optional() });
export const reorderSchema = z.object({ ids: z.array(id).min(1).max(10_000) });
export const updateDocumentSchema = z.object({
  title: name.optional(),
  topicId: id.optional(),
});
export const restoreDocumentSchema = z.object({ topicId: id });
export const readingPositionSchema = z.object({
  page: z.number().int().min(1),
  /** Fraction (0–1) of the page scrolled past the top of the viewport. */
  scroll: z.number().min(0).max(1),
});

export type CreateSubject = z.infer<typeof createSubjectSchema>;
export type UpdateSubject = z.infer<typeof updateSubjectSchema>;
export type CreateTopic = z.infer<typeof createTopicSchema>;
export type UpdateTopic = z.infer<typeof updateTopicSchema>;
export type UpdateDocument = z.infer<typeof updateDocumentSchema>;
export type ReadingPosition = z.infer<typeof readingPositionSchema>;
