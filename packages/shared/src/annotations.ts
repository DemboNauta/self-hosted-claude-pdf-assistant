import { z } from 'zod';
import { POINTER_SHAPES } from './chat.js';
import { studyTimerSchema, type StudyTimerSettings } from './focus.js';
import { voiceSettingsSchema, type VoiceSettings } from './voice.js';

const id = z.string().min(1).max(64);
const unit = z.number().min(-0.5).max(1.5);

export const normRectSchema = z.object({
  x: unit,
  y: unit,
  w: z.number().min(0).max(2),
  h: z.number().min(0).max(2),
});
export type NormRectDto = z.infer<typeof normRectSchema>;

/** Palette keys (resolved decision #2) plus Claude's own colour. */
export const HIGHLIGHT_KEYS = ['yellow', 'green', 'blue', 'red', 'purple'] as const;
export type HighlightKey = (typeof HIGHLIGHT_KEYS)[number];
export const CLAUDE_COLOR_KEY = 'claude';

export interface PaletteEntry {
  key: HighlightKey;
  color: string;
  meaning: string;
}

export const DEFAULT_PALETTE: PaletteEntry[] = [
  { key: 'yellow', color: '#f7d33d', meaning: 'Importante' },
  { key: 'green', color: '#62c370', meaning: 'Definición' },
  { key: 'blue', color: '#5ea8f2', meaning: 'Ejemplo' },
  { key: 'red', color: '#f06a6a', meaning: 'No lo entiendo' },
  { key: 'purple', color: '#b38cf0', meaning: 'Repasar' },
];
export const CLAUDE_COLOR = '#e8590c';

const quoteAnchor = {
  /** Exact text covered (used by Claude and to re-anchor); rects are what is drawn. */
  quote: z.string().max(4000).optional(),
  rects: z.array(normRectSchema).max(200).optional(),
};

export const highlightAnchorSchema = z.object(quoteAnchor);
export const noteAnchorSchema = z.union([
  z.object({ kind: z.literal('point'), x: unit, y: unit }),
  z.object({ kind: z.literal('text'), ...quoteAnchor }),
]);
export const strokeSchema = z.object({
  /** [x, y, pressure] triples in page space. */
  points: z
    .array(z.tuple([unit, unit, z.number().min(0).max(1)]))
    .min(1)
    .max(5000),
  /** Width as a fraction of the page width. */
  width: z.number().min(0.0005).max(0.05),
  color: z.string().max(32),
});
export const drawingAnchorSchema = z.object({ strokes: z.array(strokeSchema).min(1).max(200) });
export const shapeAnchorSchema = z
  .object({
    shape: z.enum(POINTER_SHAPES),
    rects: z.array(normRectSchema).max(200).optional(),
    /** Text anchor of a saved Claude mark; resolved to rects by the server. */
    quote: z.string().max(1000).optional(),
    /** Target of a connecting arrow (drawn from `rects` to `to`). */
    to: normRectSchema.optional(),
    /** Text target of a saved connecting arrow; resolved to `to` by the server. */
    toQuote: z.string().max(1000).optional(),
  })
  .refine((a) => (a.rects?.length ?? 0) > 0 || Boolean(a.quote), 'rects or quote required');

export type HighlightAnchor = z.infer<typeof highlightAnchorSchema>;
export type NoteAnchor = z.infer<typeof noteAnchorSchema>;
export type Stroke = z.infer<typeof strokeSchema>;
export type DrawingAnchor = z.infer<typeof drawingAnchorSchema>;
export type ShapeAnchor = z.infer<typeof shapeAnchorSchema>;

/**
 * How an annotation's note window is shown: pinned open or not, where it was moved to
 * and the size it was given. Kept on the server so every device shows it the same way.
 */
export const annotationDisplaySchema = z.object({
  pinned: z.boolean(),
  /** Top-left corner of the window in page space; null = next to the annotation. */
  x: unit.nullable(),
  y: unit.nullable(),
  /** Size in CSS pixels; null = default width / fit the content. */
  w: z.number().int().min(160).max(2000).nullable(),
  h: z.number().int().min(120).max(2000).nullable(),
});
export type AnnotationDisplay = z.infer<typeof annotationDisplaySchema>;

const base = {
  page: z.number().int().min(1),
  color: z.string().min(1).max(32),
  content: z.string().max(10_000).nullable().optional(),
  display: annotationDisplaySchema.nullable().optional(),
};

/** Annotation as created by the client (the user or saved Claude marks). */
export const createAnnotationSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('highlight'), anchor: highlightAnchorSchema }),
  z.object({ ...base, type: z.literal('note'), anchor: noteAnchorSchema }),
  z.object({ ...base, type: z.literal('drawing'), anchor: drawingAnchorSchema }),
  z.object({
    ...base,
    type: z.literal('shape'),
    anchor: shapeAnchorSchema,
    author: z.literal('claude').optional(),
  }),
]);
export type CreateAnnotation = z.infer<typeof createAnnotationSchema>;

export const createAnnotationsSchema = z.object({
  items: z.array(createAnnotationSchema).min(1).max(500),
  /** Restores deleted annotations with their original ids (undo). */
  ids: z.array(id).optional(),
});

export const updateAnnotationSchema = z.object({
  color: z.string().min(1).max(32).optional(),
  content: z.string().max(10_000).nullable().optional(),
  status: z.enum(['active', 'rejected', 'proposed']).optional(),
  anchor: z.unknown().optional(),
  display: annotationDisplaySchema.nullable().optional(),
});
export type UpdateAnnotation = z.infer<typeof updateAnnotationSchema>;

export const bulkStatusSchema = z.object({
  ids: z.array(id).min(1).max(1000),
  /** `proposed` only to undo an accept/reject. */
  status: z.enum(['active', 'rejected', 'proposed']),
});

export type AnnotationType = 'highlight' | 'note' | 'drawing' | 'shape';

/** A picture inside a note or highlight (served by `GET /api/note-images/:id`). */
export interface NoteImage {
  id: string;
  width: number;
  height: number;
  source: 'user' | 'claude';
  /** Page the image comes from (Claude's images from Wikimedia Commons). */
  sourceUrl: string | null;
  /** Author and licence, to credit Claude's web images. */
  credit: string | null;
  caption: string | null;
}

/** Image types a note accepts (SVG is left out: it can carry scripts). */
export const NOTE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** An image added to a note: a data URL (the browser shrinks big photos first). */
export const addNoteImageSchema = z.object({
  dataUrl: z
    .string()
    .max(20_000_000)
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/),
  caption: z.string().trim().max(300).nullable().optional(),
});
export type AddNoteImage = z.infer<typeof addNoteImageSchema>;

/** The whiteboard kept inside a note (its picture: `GET /api/boards/:id/snapshot`). */
export interface SavedBoardRef {
  id: string;
  updatedAt: string;
  /** Claude's proposal: the conversation's board is copied when it is accepted. */
  pending: boolean;
}

/** "Guardar en el PDF": the conversation's whiteboard copied into a new note. */
export const saveBoardToPdfSchema = z.object({
  threadId: id,
  page: z.number().int().min(1),
  anchor: noteAnchorSchema,
  color: z.string().min(1).max(32).optional(),
  content: z.string().max(10_000).nullable().optional(),
});
export type SaveBoardToPdf = z.infer<typeof saveBoardToPdfSchema>;

export interface Annotation {
  id: string;
  documentId: string;
  page: number;
  type: AnnotationType;
  author: 'user' | 'claude';
  status: 'active' | 'proposed' | 'rejected';
  color: string;
  anchor: HighlightAnchor | NoteAnchor | DrawingAnchor | ShapeAnchor;
  content: string | null;
  display: AnnotationDisplay | null;
  images: NoteImage[];
  /** Whiteboard saved in this note. */
  board: SavedBoardRef | null;
  createdAt: string;
  updatedAt: string;
}

/** Settings editable in the UI. */
export interface AppSettings {
  palette: PaletteEntry[];
  /** Claude model alias or id; null = CLAUDE_MODEL from the environment / Claude Code default. */
  claudeModel: string | null;
  studyTimer: StudyTimerSettings;
  /** Claude's voice in voice mode (F-CHAT-09). */
  voice: VoiceSettings;
}

export const updateSettingsSchema = z.object({
  palette: z
    .array(
      z.object({
        key: z.enum(HIGHLIGHT_KEYS),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        meaning: z.string().trim().min(1).max(60),
      }),
    )
    .length(HIGHLIGHT_KEYS.length)
    .optional(),
  claudeModel: z
    .string()
    .trim()
    .max(100)
    .regex(/^[\w.:[\]-]*$/)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v)),
  studyTimer: studyTimerSchema.optional(),
  voice: voiceSettingsSchema.optional(),
});

/**
 * Where a whiteboard note without a passage goes: the top right corner of the page,
 * below the notes already there (`taken`: the page's point notes).
 */
export function boardNoteSpot(taken: { x: number; y: number }[]): {
  kind: 'point';
  x: number;
  y: number;
} {
  const x = 0.94;
  let y = 0.05;
  while (y < 0.9 && taken.some((p) => Math.abs(p.x - x) < 0.03 && Math.abs(p.y - y) < 0.04)) {
    y += 0.06;
  }
  return { kind: 'point', x, y };
}

/** The point notes of a page (to place a new one next to them). */
export function pointNotes(list: Annotation[], page: number): { x: number; y: number }[] {
  return list
    .filter(
      (a) => a.page === page && a.type === 'note' && (a.anchor as NoteAnchor).kind === 'point',
    )
    .map((a) => a.anchor as { x: number; y: number });
}
