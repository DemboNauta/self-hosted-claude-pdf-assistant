import { MAX_CHAT_IMAGES, type ChatImage } from '@pdfclaudeassistant/shared';
import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { chatImages } from '../db/schema.js';
import { HttpError, notFound } from './errors.js';
import { newId } from './ids.js';
import type { StoredImage } from './images.js';

/** How long a picture uploaded for a question that was never sent is kept. */
const UNSENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Pictures attached to chat questions (screenshots, photos). They are uploaded while
 * the student writes, then claimed by the question that carries them; deleting the
 * conversation deletes them with its messages.
 */
export class ChatImageService {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  add(img: StoredImage): ChatImage {
    this.dropUnsent();
    const row = {
      id: newId(),
      userId: this.userId,
      mime: img.mime,
      data: img.data,
      width: img.width,
      height: img.height,
    };
    this.db.insert(chatImages).values(row).run();
    return { id: row.id, width: row.width, height: row.height };
  }

  image(id: string): { data: Buffer; mime: string } {
    const row = this.db
      .select({ data: chatImages.data, mime: chatImages.mime })
      .from(chatImages)
      .where(and(eq(chatImages.id, id), eq(chatImages.userId, this.userId)))
      .get();
    if (!row) throw notFound();
    return row;
  }

  /**
   * The bytes of pictures not sent yet, in the given order, checked before a question is
   * stored: an unknown, foreign or already sent id rejects the question.
   */
  unsent(ids: string[]): { id: string; data: Buffer; mime: string }[] {
    if (!ids.length) return [];
    if (ids.length > MAX_CHAT_IMAGES || new Set(ids).size !== ids.length)
      throw new HttpError(400, 'invalid_request');
    const rows = this.db
      .select({ id: chatImages.id, data: chatImages.data, mime: chatImages.mime })
      .from(chatImages)
      .where(
        and(
          eq(chatImages.userId, this.userId),
          inArray(chatImages.id, ids),
          isNull(chatImages.messageId),
        ),
      )
      .all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => {
      const row = byId.get(id);
      if (!row) throw new HttpError(400, 'invalid_image');
      return row;
    });
  }

  /** Gives the pictures to the question that carries them. */
  attach(messageId: string, ids: string[]) {
    ids.forEach((id, position) =>
      this.db
        .update(chatImages)
        .set({ messageId, position })
        .where(and(eq(chatImages.id, id), eq(chatImages.userId, this.userId)))
        .run(),
    );
  }

  /** Pictures of the given messages, in order, by message id. */
  forMessages(messageIds: string[]): Map<string, ChatImage[]> {
    const out = new Map<string, ChatImage[]>();
    if (!messageIds.length) return out;
    const rows = this.db
      .select({
        id: chatImages.id,
        messageId: chatImages.messageId,
        width: chatImages.width,
        height: chatImages.height,
      })
      .from(chatImages)
      .where(and(eq(chatImages.userId, this.userId), inArray(chatImages.messageId, messageIds)))
      .orderBy(asc(chatImages.position))
      .all();
    for (const { messageId, ...img } of rows) {
      const list = out.get(messageId!) ?? [];
      list.push(img);
      out.set(messageId!, list);
    }
    return out;
  }

  private dropUnsent() {
    const before = new Date(Date.now() - UNSENT_TTL_MS).toISOString();
    this.db
      .delete(chatImages)
      .where(
        and(
          eq(chatImages.userId, this.userId),
          isNull(chatImages.messageId),
          lt(chatImages.createdAt, before),
        ),
      )
      .run();
  }
}
