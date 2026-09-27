import type { BoardScene, BoardStep, SaveBoard, Whiteboard } from '@pdfclaudeassistant/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { whiteboards } from '../db/schema.js';
import type { ThreadService } from './threads.js';

type Row = typeof whiteboards.$inferSelect;

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

  /** The scene as the browser has it now, with the steps it has merged. */
  save(threadId: string, input: SaveBoard): Whiteboard {
    this.row(threadId);
    this.upsert(threadId, {
      sceneJson: JSON.stringify(input.scene),
      appliedJson: JSON.stringify(input.applied),
    });
    return this.get(threadId);
  }

  private upsert(
    threadId: string,
    set: Partial<Pick<Row, 'sceneJson' | 'stepsJson' | 'appliedJson'>>,
  ) {
    const updatedAt = now();
    this.db
      .insert(whiteboards)
      .values({ threadId, userId: this.userId, updatedAt, ...set })
      .onConflictDoUpdate({ target: whiteboards.threadId, set: { ...set, updatedAt } })
      .run();
  }
}
