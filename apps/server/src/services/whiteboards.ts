import type {
  BoardBounds,
  BoardScene,
  BoardStep,
  SaveBoard,
  Whiteboard,
} from '@pdfclaudeassistant/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { whiteboards } from '../db/schema.js';
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
    return this.get(threadId);
  }

  /** What Claude should know about the board this turn (goes in the turn context). */
  status(threadId: string): { hasContent: boolean; studentChanged: boolean } {
    const row = this.row(threadId);
    return {
      hasContent: !!row?.snapshotPng,
      studentChanged: !!row?.studentEditedAt && (!row.seenAt || row.studentEditedAt > row.seenAt),
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
