import { z } from 'zod';

/**
 * Visual schema of a document or part of it, drawn by Claude as Mermaid source
 * (mind map, tree or flowchart: Claude picks what fits the content). Every diagram
 * is kept, listed with its PDF and on the general "Esquemas" page.
 */
export interface Diagram {
  id: string;
  documentId: string | null;
  /** Title of the document it comes from (null if that PDF is gone). */
  documentTitle: string | null;
  title: string;
  /** Mermaid source. */
  source: string;
  /** Pages it covers (both null = the whole document or unknown). */
  fromPage: number | null;
  toPage: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Diagram types Claude may use; anything else is rejected before it is saved. */
export const DIAGRAM_KINDS = ['mindmap', 'flowchart', 'graph'] as const;

export const updateDiagramSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

/**
 * Markup Claude writes in an answer where a diagram goes: `[[diagram:ID]]`. The chat
 * renders the diagram there.
 */
export const DIAGRAM_RE = /\[\[diagram:([0-9a-z]{1,64})\]\]/g;
