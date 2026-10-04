import type { NoteImage, SavedBoardRef } from '@pdfclaudeassistant/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { annotationImages, savedBoards, whiteboards } from '../db/schema.js';
import { HttpError, notFound } from './errors.js';
import { newId } from './ids.js';
import type { StoredImage } from './images.js';

/** Most pictures one note holds. */
export const MAX_IMAGES_PER_NOTE = 12;
/** How long the media of a deleted annotation is kept for undo. */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

const now = () => new Date().toISOString();

type ImageRow = typeof annotationImages.$inferSelect;

const imageDto = (r: Omit<ImageRow, 'data'>): NoteImage => ({
  id: r.id,
  width: r.width,
  height: r.height,
  source: r.source,
  sourceUrl: r.sourceUrl,
  credit: r.credit,
  caption: r.caption,
});

/** Columns of an image without its bytes (listing never loads them). */
const imageMeta = {
  id: annotationImages.id,
  userId: annotationImages.userId,
  documentId: annotationImages.documentId,
  annotationId: annotationImages.annotationId,
  mime: annotationImages.mime,
  width: annotationImages.width,
  height: annotationImages.height,
  source: annotationImages.source,
  sourceUrl: annotationImages.sourceUrl,
  credit: annotationImages.credit,
  caption: annotationImages.caption,
  orphanedAt: annotationImages.orphanedAt,
  createdAt: annotationImages.createdAt,
};

export interface ImageMeta {
  source: 'user' | 'claude';
  sourceUrl?: string | null;
  credit?: string | null;
  caption?: string | null;
}

/**
 * What a note holds besides its text: pictures and a saved whiteboard. Media follow
 * their annotation: deleting it orphans them (kept a day, so undo brings them back).
 */
export class NoteMediaService {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  // ---- listing (with the annotations) ----

  imagesFor(annotationIds: string[]): Map<string, NoteImage[]> {
    const out = new Map<string, NoteImage[]>();
    if (!annotationIds.length) return out;
    const rows = this.db
      .select(imageMeta)
      .from(annotationImages)
      .where(
        and(
          eq(annotationImages.userId, this.userId),
          inArray(annotationImages.annotationId, annotationIds),
          isNull(annotationImages.orphanedAt),
        ),
      )
      .orderBy(asc(annotationImages.createdAt), asc(annotationImages.id))
      .all();
    for (const r of rows) {
      const list = out.get(r.annotationId) ?? [];
      list.push(imageDto(r));
      out.set(r.annotationId, list);
    }
    return out;
  }

  boardsFor(annotationIds: string[]): Map<string, SavedBoardRef> {
    const out = new Map<string, SavedBoardRef>();
    if (!annotationIds.length) return out;
    const rows = this.db
      .select({
        id: savedBoards.id,
        annotationId: savedBoards.annotationId,
        updatedAt: savedBoards.updatedAt,
        pendingThreadId: savedBoards.pendingThreadId,
      })
      .from(savedBoards)
      .where(
        and(
          eq(savedBoards.userId, this.userId),
          inArray(savedBoards.annotationId, annotationIds),
          isNull(savedBoards.orphanedAt),
        ),
      )
      .all();
    for (const r of rows) {
      out.set(r.annotationId, { id: r.id, updatedAt: r.updatedAt, pending: !!r.pendingThreadId });
    }
    return out;
  }

  // ---- images ----

  addImage(documentId: string, annotationId: string, img: StoredImage, meta: ImageMeta): NoteImage {
    const count = this.imagesFor([annotationId]).get(annotationId)?.length ?? 0;
    if (count >= MAX_IMAGES_PER_NOTE) throw new HttpError(409, 'too_many_images');
    const row = {
      id: newId(),
      userId: this.userId,
      documentId,
      annotationId,
      mime: img.mime,
      data: img.data,
      width: img.width,
      height: img.height,
      source: meta.source,
      sourceUrl: meta.sourceUrl ?? null,
      credit: meta.credit ?? null,
      caption: meta.caption?.trim() || null,
    };
    this.db.insert(annotationImages).values(row).run();
    return imageDto({ ...row, orphanedAt: null, createdAt: now() });
  }

  image(id: string): { data: Buffer; mime: string } {
    const row = this.db
      .select({ data: annotationImages.data, mime: annotationImages.mime })
      .from(annotationImages)
      .where(and(eq(annotationImages.id, id), eq(annotationImages.userId, this.userId)))
      .get();
    if (!row) throw notFound();
    return row;
  }

  /** The note an image belongs to (to refresh it after a change). */
  imageOwner(id: string): string {
    const row = this.db
      .select({ annotationId: annotationImages.annotationId })
      .from(annotationImages)
      .where(and(eq(annotationImages.id, id), eq(annotationImages.userId, this.userId)))
      .get();
    if (!row) throw notFound();
    return row.annotationId;
  }

  setCaption(id: string, caption: string | null) {
    this.imageOwner(id);
    this.db
      .update(annotationImages)
      .set({ caption: caption?.trim() || null })
      .where(and(eq(annotationImages.id, id), eq(annotationImages.userId, this.userId)))
      .run();
  }

  deleteImage(id: string) {
    this.db
      .delete(annotationImages)
      .where(and(eq(annotationImages.id, id), eq(annotationImages.userId, this.userId)))
      .run();
  }

  // ---- saved whiteboards ----

  /**
   * Keeps a copy of a whiteboard in a note: the scene and picture given, or (Claude's
   * proposal, `pendingThreadId`) the conversation's board once the note is accepted.
   */
  createBoard(
    documentId: string,
    annotationId: string,
    content: { sceneJson: string; snapshotPng: string | null } | { pendingThreadId: string },
  ): SavedBoardRef {
    const ts = now();
    const row = {
      id: newId(),
      userId: this.userId,
      documentId,
      annotationId,
      sceneJson: 'sceneJson' in content ? content.sceneJson : null,
      snapshotPng: 'sceneJson' in content ? content.snapshotPng : null,
      pendingThreadId: 'pendingThreadId' in content ? content.pendingThreadId : null,
      updatedAt: ts,
    };
    this.db.insert(savedBoards).values(row).run();
    return { id: row.id, updatedAt: ts, pending: !!row.pendingThreadId };
  }

  board(id: string) {
    const row = this.db
      .select()
      .from(savedBoards)
      .where(
        and(
          eq(savedBoards.id, id),
          eq(savedBoards.userId, this.userId),
          isNull(savedBoards.orphanedAt),
        ),
      )
      .get();
    if (!row) throw notFound();
    return row;
  }

  /** The board's picture; a proposal not accepted yet shows the conversation's board. */
  boardSnapshot(id: string): Buffer | null {
    const row = this.board(id);
    let png = row.snapshotPng;
    if (row.pendingThreadId) {
      png =
        this.db
          .select({ png: whiteboards.snapshotPng })
          .from(whiteboards)
          .where(
            and(eq(whiteboards.threadId, row.pendingThreadId), eq(whiteboards.userId, this.userId)),
          )
          .get()?.png ?? null;
    }
    return png ? Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64') : null;
  }

  /** A save of the conversation's board that is editing this saved board. */
  updateBoard(id: string, sceneJson: string, snapshotPng: string | null) {
    this.db
      .update(savedBoards)
      .set({ sceneJson, snapshotPng, pendingThreadId: null, updatedAt: now() })
      .where(
        and(
          eq(savedBoards.id, id),
          eq(savedBoards.userId, this.userId),
          isNull(savedBoards.orphanedAt),
        ),
      )
      .run();
  }

  /**
   * The conversation's board was saved: boards Claude kept in this answer
   * (`pending_thread_id`) take the new drawing, so steps revealed later are included.
   */
  followThread(threadId: string, sceneJson: string, snapshotPng: string | null | undefined) {
    this.db
      .update(savedBoards)
      .set({
        sceneJson,
        ...(snapshotPng !== undefined && { snapshotPng }),
        updatedAt: now(),
      })
      .where(
        and(
          eq(savedBoards.userId, this.userId),
          eq(savedBoards.pendingThreadId, threadId),
          isNull(savedBoards.orphanedAt),
        ),
      )
      .run();
  }

  /** A new turn (or the board is replaced): Claude's boards of this thread are final. */
  settleThread(threadId: string) {
    const ids = this.db
      .select({ annotationId: savedBoards.annotationId })
      .from(savedBoards)
      .where(and(eq(savedBoards.userId, this.userId), eq(savedBoards.pendingThreadId, threadId)))
      .all()
      .map((r) => r.annotationId);
    this.materializeBoards(ids);
  }

  /** Boards still following their thread get the board as it is now, and stop following. */
  materializeBoards(annotationIds: string[]) {
    if (!annotationIds.length) return;
    const pending = this.db
      .select({ id: savedBoards.id, threadId: savedBoards.pendingThreadId })
      .from(savedBoards)
      .where(
        and(
          eq(savedBoards.userId, this.userId),
          inArray(savedBoards.annotationId, annotationIds),
          isNotNull(savedBoards.pendingThreadId),
        ),
      )
      .all();
    for (const p of pending) {
      const wb = this.db
        .select({ scene: whiteboards.sceneJson, png: whiteboards.snapshotPng })
        .from(whiteboards)
        .where(and(eq(whiteboards.threadId, p.threadId!), eq(whiteboards.userId, this.userId)))
        .get();
      this.db
        .update(savedBoards)
        .set({
          sceneJson: wb?.scene ?? null,
          snapshotPng: wb?.png ?? null,
          pendingThreadId: null,
          updatedAt: now(),
        })
        .where(eq(savedBoards.id, p.id))
        .run();
    }
  }

  // ---- following the annotation's life ----

  /** The annotations were deleted: their media wait a day for an undo. */
  orphan(annotationIds: string[]) {
    if (!annotationIds.length) return;
    const ts = now();
    this.db
      .update(annotationImages)
      .set({ orphanedAt: ts })
      .where(
        and(
          eq(annotationImages.userId, this.userId),
          inArray(annotationImages.annotationId, annotationIds),
        ),
      )
      .run();
    this.db
      .update(savedBoards)
      .set({ orphanedAt: ts })
      .where(
        and(eq(savedBoards.userId, this.userId), inArray(savedBoards.annotationId, annotationIds)),
      )
      .run();
    this.purge();
  }

  /** The annotations came back (undo): so do their media. */
  restore(annotationIds: string[]) {
    if (!annotationIds.length) return;
    this.db
      .update(annotationImages)
      .set({ orphanedAt: null })
      .where(
        and(
          eq(annotationImages.userId, this.userId),
          inArray(annotationImages.annotationId, annotationIds),
        ),
      )
      .run();
    this.db
      .update(savedBoards)
      .set({ orphanedAt: null })
      .where(
        and(eq(savedBoards.userId, this.userId), inArray(savedBoards.annotationId, annotationIds)),
      )
      .run();
  }

  /** Drops media orphaned for more than a day. */
  private purge() {
    const before = new Date(Date.now() - ORPHAN_TTL_MS).toISOString();
    this.db
      .delete(annotationImages)
      .where(and(eq(annotationImages.userId, this.userId), lt(annotationImages.orphanedAt, before)))
      .run();
    this.db
      .delete(savedBoards)
      .where(and(eq(savedBoards.userId, this.userId), lt(savedBoards.orphanedAt, before)))
      .run();
  }
}
