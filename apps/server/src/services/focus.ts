import type { RecordFocus } from '@pdfclaudeassistant/shared';
import type { Db } from '../db/client.js';
import { documents, focusSessions } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';

/** Study-timer focus blocks (F-FOCUS-02), shown in the statistics. */
export class FocusService {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  /** Idempotent: a block already recorded (e.g. by another tab) is ignored. */
  record(block: RecordFocus) {
    const docExists =
      block.documentId !== null &&
      this.db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, block.documentId), eq(documents.userId, this.userId)))
        .get();
    this.db
      .insert(focusSessions)
      .values({
        id: block.id,
        userId: this.userId,
        documentId: docExists ? block.documentId : null,
        day: block.day,
        seconds: block.seconds,
        completed: block.completed,
        method: block.method,
      })
      .onConflictDoNothing()
      .run();
  }
}
