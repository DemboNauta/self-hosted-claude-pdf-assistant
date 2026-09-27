import { z } from 'zod';

/**
 * Whiteboard (visual interaction, block 2): a hand-drawn board next to the chat where
 * Claude draws explanations step by step and the student can draw too. The board is an
 * Excalidraw scene; Claude draws with a small vocabulary of elements (below) that the
 * browser turns into Excalidraw elements.
 */

/** Width of the board's coordinate space Claude draws in (y grows downwards, unbounded). */
export const BOARD_WIDTH = 1000;

export const BOARD_COLORS = ['black', 'blue', 'red', 'green', 'orange', 'purple', 'gray'] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];

const coord = z.number().min(-2000).max(20_000);
const size = z.number().min(1).max(5000);
const elementId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/)
  .describe('Your name for the element, to connect arrows to it');
const color = z.enum(BOARD_COLORS).optional();
const label = z.string().max(300).optional();
const point = z.tuple([coord, coord]);

export const boardElementSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    id: elementId.optional(),
    x: coord,
    y: coord,
    text: z.string().min(1).max(2000),
    size: z.enum(['s', 'm', 'l', 'xl']).optional(),
    color,
  }),
  z.object({
    type: z.enum(['rect', 'ellipse', 'diamond']),
    id: elementId.optional(),
    x: coord,
    y: coord,
    w: size,
    h: size,
    label,
    color,
    /** Filled with a light tint of the colour. */
    fill: z.boolean().optional(),
  }),
  z.object({
    type: z.enum(['arrow', 'line']),
    id: elementId.optional(),
    /** Connect two elements by id (the arrow follows them), or give points. */
    from: elementId.optional(),
    to: elementId.optional(),
    points: z.array(point).min(2).max(50).optional(),
    label,
    color,
    dashed: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('freehand'),
    points: z.array(point).min(2).max(500),
    color,
  }),
  z.object({
    /** A crop of a PDF page pasted on the board (a figure, a formula…). */
    type: z.literal('pdf'),
    id: elementId.optional(),
    docId: z.string().max(64).optional(),
    page: z.number().int().min(1),
    region: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        w: z.number().min(0.02).max(1),
        h: z.number().min(0.02).max(1),
      })
      .optional(),
    x: coord,
    y: coord,
    /** Width on the board; the height keeps the crop's proportions. */
    w: size,
  }),
]);
export type BoardElement = z.infer<typeof boardElementSchema>;

/** A `pdf` element once the server rendered its crop: the image and its size. */
export type ResolvedBoardElement =
  | Exclude<BoardElement, { type: 'pdf' }>
  | (Extract<BoardElement, { type: 'pdf' }> & { fileId: string; h: number });

/** One call of Claude's `whiteboard_draw`: shown at once, as one step of the explanation. */
export interface BoardStep {
  /** Step id within the answer ("w1", "w2"…), referenced in the text as `[[mark:w1]]`. */
  id: string;
  /** Assistant message that drew it. */
  messageId: string;
  /** Wipe the board before drawing. */
  clear?: boolean;
  elements: ResolvedBoardElement[];
  /** A Mermaid diagram drawn on the board (converted in the browser), below the rest. */
  mermaid?: string;
  /** PNG data URLs of the PDF crops, by file id. */
  files?: Record<string, string>;
  createdAt: string;
}

/** Excalidraw scene as saved by the browser (elements and image files, opaque here). */
export interface BoardScene {
  elements: unknown[];
  files: Record<string, unknown>;
}

export interface Whiteboard {
  threadId: string;
  /** Latest saved scene, null until the board is first drawn on. */
  scene: BoardScene | null;
  /** Everything Claude drew, in order. */
  steps: BoardStep[];
  /** Keys (`messageId:stepId`) of the steps already merged into `scene`. */
  applied: string[];
  updatedAt: string;
}

/** Part of the board a snapshot shows, in board units. */
export const boardBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().min(0),
  h: z.number().min(0),
});
export type BoardBounds = z.infer<typeof boardBoundsSchema>;

export const saveBoardSchema = z.object({
  scene: z.object({
    elements: z.array(z.unknown()).max(5000),
    files: z.record(z.string(), z.unknown()),
  }),
  applied: z.array(z.string().max(80)).max(2000),
  /**
   * PNG of the whole drawing (data URL) and the area it shows, so Claude can look at
   * the board (`whiteboard_view`); null when the board is empty.
   */
  snapshot: z
    .object({
      png: z
        .string()
        .max(8_000_000)
        .regex(/^data:image\/png;base64,/),
      bounds: boardBoundsSchema,
    })
    .nullable()
    .optional(),
  /** The student drew or wrote on the board since the last save. */
  studentEdited: z.boolean().optional(),
});
export type SaveBoard = z.infer<typeof saveBoardSchema>;

export const boardStepKey = (s: Pick<BoardStep, 'messageId' | 'id'>) => `${s.messageId}:${s.id}`;
