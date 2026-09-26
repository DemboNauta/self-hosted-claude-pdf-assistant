import { z } from 'zod';

/** Study modes (F-CHAT-03). Each one is an instruction template sent with the question. */
export const STUDY_MODES = ['free', 'eli5', 'summary', 'exam', 'relate'] as const;
export type StudyMode = (typeof STUDY_MODES)[number];

/** Summary formats for the `summary` mode. */
export const SUMMARY_FORMATS = ['prose', 'outline', 'glossary'] as const;
export type SummaryFormat = (typeof SUMMARY_FORMATS)[number];

const id = z.string().min(1).max(64);

export const selectionSchema = z.object({
  page: z.number().int().min(1),
  text: z.string().trim().min(1).max(8000),
});
export type TextSelection = z.infer<typeof selectionSchema>;

const unitSchema = z.number().min(0).max(1);

/**
 * Area the student marked with freehand drawings to ask about it. The server renders
 * that part of the page with the drawings on top and sends the image to Claude.
 */
export const markSchema = z.object({
  page: z.number().int().min(1),
  /** Bounding box of the drawings (plus a margin), in normalised page space. */
  rect: z.object({ x: unitSchema, y: unitSchema, w: unitSchema, h: unitSchema }),
  /** The drawing annotations that make up the mark. */
  annotationIds: z.array(id).min(1).max(50),
  /** Text of the page inside the marked area (may be empty: figures, formulas). */
  text: z.string().max(8000),
});
export type DrawingMark = z.infer<typeof markSchema>;

/** Per-turn context: goes in the user message, never the system prompt (see CLAUDE.md). */
export const chatContextSchema = z
  .object({
    /** Exactly one of docId / topicId / subjectId: what the conversation is about. */
    docId: id.optional(),
    topicId: id.optional(),
    subjectId: id.optional(),
    currentPage: z.number().int().min(1).optional(),
    selection: selectionSchema.optional(),
    mark: markSchema.optional(),
    summaryFormat: z.enum(SUMMARY_FORMATS).optional(),
  })
  .refine((c) => [c.docId, c.topicId, c.subjectId].filter(Boolean).length === 1, {
    message: 'one scope required',
  });
export type ChatContext = z.infer<typeof chatContextSchema>;

export const clientChatEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user_message'),
    threadId: id,
    /** Client-generated id, echoed back so the UI can reconcile its optimistic message. */
    clientId: z.string().min(1).max(64),
    text: z.string().trim().max(20_000),
    mode: z.enum(STUDY_MODES).default('free'),
    context: chatContextSchema,
  }),
  z.object({ type: z.literal('stop'), threadId: id }),
]);
export type ClientChatEvent = z.infer<typeof clientChatEventSchema>;

export type ChatErrorCode = 'rate_limited' | 'auth_expired' | 'busy' | 'internal';

/** A tool Claude used while answering, shown as a small status line in the chat. */
export interface ToolEvent {
  id: string;
  name: string;
  /** Short human-readable summary of the input (e.g. "p. 3–5"). */
  summary: string;
  status: 'running' | 'done' | 'error';
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  mode?: StudyMode;
  context?: ChatContext;
  toolEvents?: ToolEvent[];
  status: 'complete' | 'interrupted' | 'error' | 'streaming';
  errorCode?: ChatErrorCode | null;
  createdAt: string;
}

/** What a thread is about (F-CHAT-07 document threads, F-CHAT-08 topic/subject ones). */
export type ThreadScope = { kind: 'document' | 'topic' | 'subject'; id: string };

export interface ThreadSummary {
  id: string;
  documentId: string | null;
  topicId: string | null;
  subjectId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/**
 * Pointer shapes Claude draws on the page (F-POINT-01). Anchors are either an exact
 * quote found in the text layer or a rectangle in normalised page space (0–1).
 */
export const anchorSchema = z.union([
  z.object({
    kind: z.literal('text'),
    quote: z.string().min(1).max(500),
    occurrence: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    kind: z.literal('rect'),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  }),
]);
export type Anchor = z.infer<typeof anchorSchema>;

export const POINTER_SHAPES = ['arrow', 'circle', 'rect', 'highlight', 'label'] as const;
export const pointerShapeSchema = z.object({
  type: z.enum(POINTER_SHAPES),
  anchor: anchorSchema,
  label: z.string().max(200).optional(),
});
export type PointerShape = z.infer<typeof pointerShapeSchema>;

export interface PointerGroup {
  /** Assistant message that produced the shapes (F-POINT-02). */
  messageId: string;
  docId: string;
  page: number;
  shapes: PointerShape[];
}

export type ServerChatEvent =
  | { type: 'user_message'; clientId: string; message: ChatMessage }
  | { type: 'assistant_start'; threadId: string; message: ChatMessage }
  | { type: 'assistant_delta'; threadId: string; messageId: string; text: string }
  | { type: 'tool_event'; threadId: string; messageId: string; event: ToolEvent }
  | { type: 'pointer'; threadId: string; group: PointerGroup }
  | { type: 'clear_pointers'; threadId: string }
  | { type: 'data_changed'; threadId: string; scope: 'memory' | 'annotations' | 'flashcards' }
  | { type: 'assistant_done'; threadId: string; message: ChatMessage }
  | { type: 'error'; threadId?: string; messageId?: string; code: ChatErrorCode; message?: string };

/**
 * Citation markup Claude writes in answers (F-CHAT-04): `[[cite:docId:page|"quote"]]`,
 * the quote being optional. Rendered as a chip that jumps to the page.
 */
export const CITATION_RE =
  /\[\[cite:([0-9a-z]{1,64}):(\d{1,6})(?:\|"((?:[^"\\]|\\.){0,500})")?\]\]/g;

export interface Citation {
  docId: string;
  page: number;
  quote?: string;
}

export function parseCitation(match: RegExpMatchArray): Citation {
  return {
    docId: match[1]!,
    page: Number(match[2]),
    ...(match[3] ? { quote: match[3].replace(/\\"/g, '"') } : {}),
  };
}
