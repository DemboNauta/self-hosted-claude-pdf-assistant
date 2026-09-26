import type { RecordFocus } from '@pdfclaudeassistant/shared';
import type { Db } from '../db/client.js';
import { documents, focusSessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/** Study-timer focus blocks (F-FOCUS-02), shown in the statistics. */
export class FocusService {
  constructor(private readonly db: Db) {}

  /** Idempotent: a block already recorded (e.g. by another tab) is ignored. */
  record(block: RecordFocus) {
    const docExists =
      block.documentId !== null &&
      this.db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.id, block.documentId))
        .get();
    this.db
      .insert(focusSessions)
      .values({
        id: block.id,
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
