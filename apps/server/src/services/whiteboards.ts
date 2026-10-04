import {
  boardStepKey,
  type BoardBounds,
  type BoardScene,
  type BoardStep,
  type LinkedBoard,
  type SaveBoard,
  type Whiteboard,
} from '@pdfclaudeassistant/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { annotations, savedBoards, whiteboards } from '../db/schema.js';
import { HttpError } from './errors.js';
import type { NoteMediaService } from './noteMedia.js';
import type { ThreadService } from './threads.js';

type Row = typeof whiteboards.$inferSelect;
type Patch = Partial<
  Pick<
    Row,
    | 'sceneJson'
    | 'stepsJson'
    | 'appliedJson'
    | 'snapshotPng'
    | 'snapshotBoundsJson'
    | 'studentEditedAt'
    | 'seenAt'
    | 'linkedBoardId'
  >
>;

const now = () => new Date().toISOString();

/** Most steps kept per board: older ones are already merged into the saved scene. */
const MAX_STEPS = 300;

/** The whiteboard of each chat thread (one per thread, created when first used). */
export class WhiteboardService {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
    private readonly threads: ThreadService,
    private readonly media: NoteMediaService,
  ) {}

  private row(threadId: string): Row | undefined {
    // Checks the thread is the user's (throws not found otherwise).
    this.threads.get(threadId);
    return this.db.select().from(whiteboards).where(eq(whiteboards.threadId, threadId)).get();
  }

  get(threadId: string): Whiteboard {
    const row = this.row(threadId);
    return {
      threadId,
      scene: row?.sceneJson ? (JSON.parse(row.sceneJson) as BoardScene) : null,
      steps: row ? (JSON.parse(row.stepsJson) as BoardStep[]) : [],
      applied: row ? (JSON.parse(row.appliedJson) as string[]) : [],
      linked: row?.linkedBoardId ? this.linkedInfo(row.linkedBoardId) : null,
      updatedAt: row?.updatedAt ?? now(),
    };
  }

  /** Records a step Claude drew; the browser merges it into the scene. */
  addStep(threadId: string, step: BoardStep): void {
    const board = this.get(threadId);
    const steps = [...board.steps, step].slice(-MAX_STEPS);
    this.upsert(threadId, { stepsJson: JSON.stringify(steps) });
  }

  /** Changes a step Claude drew earlier in the same answer (`amend`). */
  replaceStep(threadId: string, step: BoardStep): void {
    const board = this.get(threadId);
    const steps = board.steps.map((s) =>
      s.messageId === step.messageId && s.id === step.id ? step : s,
    );
    this.upsert(threadId, { stepsJson: JSON.stringify(steps) });
  }

  /** The scene as the browser has it now, with the steps it has merged and a snapshot. */
  save(threadId: string, input: SaveBoard): Whiteboard {
    this.row(threadId);
    this.upsert(threadId, {
      sceneJson: JSON.stringify(input.scene),
      appliedJson: JSON.stringify(input.applied),
      ...(input.snapshot !== undefined && {
        snapshotPng: input.snapshot?.png ?? null,
        snapshotBoundsJson: input.snapshot ? JSON.stringify(input.snapshot.bounds) : null,
      }),
      ...(input.studentEdited && { studentEditedAt: now() }),
    });
    // Editing a note's board: the note keeps the latest drawing too.
    const linked = this.row(threadId)?.linkedBoardId;
    if (linked && this.linkedInfo(linked)) {
      const png =
        input.snapshot === undefined
          ? this.media.board(linked).snapshotPng
          : (input.snapshot?.png ?? null);
      this.media.updateBoard(linked, JSON.stringify(input.scene), png);
    }
    return this.get(threadId);
  }

  /** The board as it is now, to keep a copy in a note ("Guardar en el PDF"). */
  copy(threadId: string): { sceneJson: string; snapshotPng: string | null } {
    const row = this.row(threadId);
    const scene = row?.sceneJson ? (JSON.parse(row.sceneJson) as BoardScene) : null;
    if (!row || !scene?.elements.length) throw new HttpError(409, 'board_empty');
    return { sceneJson: row.sceneJson!, snapshotPng: row.snapshotPng };
  }

  /**
   * Puts a note's board on the conversation's board, linked so later saves update the
   * note ("Editar en la pizarra"); with null, empties the board ("Nueva pizarra").
   * Claude's earlier steps count as merged, so they are not drawn again.
   */
  replace(threadId: string, boardId: string | null): Whiteboard {
    const board = this.get(threadId);
    const saved = boardId ? this.media.board(boardId) : null;
    if (saved?.pendingThreadId) throw new HttpError(409, 'board_pending');
    const scene: BoardScene = saved?.sceneJson
      ? (JSON.parse(saved.sceneJson) as BoardScene)
      : { elements: [], files: {} };
    this.upsert(threadId, {
      sceneJson: JSON.stringify(scene),
      appliedJson: JSON.stringify(board.steps.map(boardStepKey)),
      snapshotPng: saved?.snapshotPng ?? null,
      snapshotBoundsJson: null,
      linkedBoardId: saved?.id ?? null,
      // Claude should look before correcting a board it has not seen.
      studentEditedAt: saved ? now() : null,
    });
    return this.get(threadId);
  }

  /** Stops saving into the note's board; the drawing stays on the conversation's board. */
  unlink(threadId: string): Whiteboard {
    this.row(threadId);
    this.upsert(threadId, { linkedBoardId: null });
    return this.get(threadId);
  }

  /** Where the linked board lives, or null when its note is gone. */
  private linkedInfo(boardId: string): LinkedBoard | null {
    const r = this.db
      .select({
        boardId: savedBoards.id,
        annotationId: savedBoards.annotationId,
        documentId: savedBoards.documentId,
        page: annotations.page,
      })
      .from(savedBoards)
      .innerJoin(annotations, eq(annotations.id, savedBoards.annotationId))
      .where(
        and(
          eq(savedBoards.id, boardId),
          eq(savedBoards.userId, this.userId),
          isNull(savedBoards.orphanedAt),
        ),
      )
      .get();
    return r ?? null;
  }

  /** What Claude should know about the board this turn (goes in the turn context). */
  status(threadId: string): {
    hasContent: boolean;
    studentChanged: boolean;
    linkedPage: number | null;
  } {
    const row = this.row(threadId);
    return {
      hasContent: !!row?.snapshotPng,
      studentChanged: !!row?.studentEditedAt && (!row.seenAt || row.studentEditedAt > row.seenAt),
      linkedPage: row?.linkedBoardId ? (this.linkedInfo(row.linkedBoardId)?.page ?? null) : null,
    };
  }

  /** The latest picture of the board for Claude; marks the board as seen. */
  look(threadId: string): { png: Buffer; bounds: BoardBounds } | null {
    const row = this.row(threadId);
    if (!row?.snapshotPng) return null;
    this.upsert(threadId, { seenAt: now() });
    return {
      png: Buffer.from(row.snapshotPng.replace(/^data:image\/png;base64,/, ''), 'base64'),
      bounds: JSON.parse(row.snapshotBoundsJson ?? '{"x":0,"y":0,"w":0,"h":0}') as BoardBounds,
    };
  }

  private upsert(threadId: string, set: Patch) {
    const updatedAt = now();
    this.db
      .insert(whiteboards)
      .values({ threadId, userId: this.userId, updatedAt, ...set })
      .onConflictDoUpdate({ target: whiteboards.threadId, set: { ...set, updatedAt } })
      .run();
  }
}
