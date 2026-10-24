import {
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILES,
  type ChatFile,
  type ChatFileKind,
} from '@pdfclaudeassistant/shared';
import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import mammoth from 'mammoth';
import type { Db } from '../db/client.js';
import { chatFiles, messages } from '../db/schema.js';
import { pdfPageTexts } from '../ingest/extract.js';
import { HttpError, notFound } from './errors.js';
import { newId } from './ids.js';

/** How long a file uploaded for a question that was never sent is kept. */
const UNSENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Size of a part of a Word or text file (about two book pages). */
const PART_CHARS = 6000;

/** A file read and ready to store: its kind, type and text split in parts. */
export interface ReadFile {
  kind: ChatFileKind;
  mime: string;
  parts: string[];
}

/** A stored file with its bytes and text, for Claude. */
export interface ChatFileContent extends ChatFile {
  data: Buffer;
  texts: string[];
}

const MIME: Record<ChatFileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  text: 'text/plain; charset=utf-8',
};

/**
 * Works out what a file is from its bytes (never trusting the name or declared type) and
 * reads its text: PDF pages, a Word document as light Markdown, or UTF-8 text. Anything
 * else (old .doc, spreadsheets, binaries) is refused.
 */
export async function readChatFile(buf: Buffer, name: string): Promise<ReadFile> {
  if (!buf.length) throw new HttpError(400, 'unsupported_file');
  if (buf.length > MAX_CHAT_FILE_BYTES) throw new HttpError(413, 'file_too_large');
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    let pages: string[];
    try {
      pages = await pdfPageTexts(buf);
    } catch {
      throw new HttpError(400, 'unreadable_file');
    }
    return { kind: 'pdf', mime: MIME.pdf, parts: pages };
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b && /\.docx$/i.test(name)) {
    let html: string;
    try {
      html = (
        await mammoth.convertToHtml(
          { buffer: buf },
          // Pictures inside the document are left out: only its text reaches Claude.
          { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
        )
      ).value;
    } catch {
      throw new HttpError(400, 'unreadable_file');
    }
    return { kind: 'docx', mime: MIME.docx, parts: splitParts(htmlToText(html)) };
  }
  if (!buf.includes(0)) {
    try {
      // The decoder drops a leading byte order mark by itself.
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return { kind: 'text', mime: MIME.text, parts: splitParts(text) };
    } catch {
      // Not UTF-8: fall through.
    }
  }
  throw new HttpError(400, 'unsupported_file');
}

/** Mammoth's HTML as light Markdown: headings, lists, tables and emphasis survive. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<h([1-6])[^>]*>/g, (_, n: string) => `\n\n${'#'.repeat(Number(n))} `)
      .replace(/<\/h[1-6]>/g, '\n\n')
      .replace(/<li[^>]*>/g, '\n- ')
      .replace(/<\/(ul|ol)>/g, '\n\n')
      .replace(/<tr[^>]*>/g, '\n| ')
      .replace(/<\/t[dh]>/g, ' | ')
      .replace(/<\/table>/g, '\n\n')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/p>/g, '\n\n')
      .replace(/<\/?(strong|b)>/g, '**')
      .replace(/<\/?(em|i)>/g, '*')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

/** Splits text in parts of about `PART_CHARS`, at paragraph or line breaks when possible. */
export function splitParts(text: string, size = PART_CHARS): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size / 2) cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = rest.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest || !parts.length) parts.push(rest);
  return parts;
}

/** A file name safe to store and show: no path, no control characters, bounded. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);
  return name || 'archivo';
}

/**
 * Files attached to chat questions (PDF, Word, text) for Claude to read. Uploaded while
 * the student writes, then claimed by the question that carries them; deleting the
 * conversation deletes them with its messages.
 */
export class ChatFileService {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  add(name: string, buf: Buffer, file: ReadFile): ChatFile {
    this.dropUnsent();
    const row = {
      id: newId(),
      userId: this.userId,
      name: cleanFileName(name),
      kind: file.kind,
      mime: file.mime,
      size: buf.length,
      data: buf,
      partCount: file.parts.length,
      partsJson: JSON.stringify(file.parts),
    };
    this.db.insert(chatFiles).values(row).run();
    return { id: row.id, name: row.name, kind: row.kind, size: row.size, parts: file.parts.length };
  }

  /** The bytes, for the student to download (or open, for a PDF). */
  file(id: string): { data: Buffer; mime: string; name: string; kind: ChatFileKind } {
    const row = this.db
      .select({
        data: chatFiles.data,
        mime: chatFiles.mime,
        name: chatFiles.name,
        kind: chatFiles.kind,
      })
      .from(chatFiles)
      .where(and(eq(chatFiles.id, id), eq(chatFiles.userId, this.userId)))
      .get();
    if (!row) throw notFound();
    return row;
  }

  /**
   * Files not sent yet, in the given order, checked before a question is stored: an
   * unknown, foreign or already sent id rejects the question.
   */
  unsent(ids: string[]): ChatFileContent[] {
    if (!ids.length) return [];
    if (ids.length > MAX_CHAT_FILES || new Set(ids).size !== ids.length)
      throw new HttpError(400, 'invalid_request');
    const rows = this.db
      .select()
      .from(chatFiles)
      .where(
        and(
          eq(chatFiles.userId, this.userId),
          inArray(chatFiles.id, ids),
          isNull(chatFiles.messageId),
        ),
      )
      .all();
    const byId = new Map(rows.map((r) => [r.id, toContent(r)]));
    return ids.map((id) => {
      const row = byId.get(id);
      if (!row) throw new HttpError(400, 'invalid_file');
      return row;
    });
  }

  /** A file sent in the given conversation, with its text (Claude's tools). */
  inThread(threadId: string, id: string): ChatFileContent | null {
    const row = this.db
      .select({ file: chatFiles })
      .from(chatFiles)
      .innerJoin(messages, eq(messages.id, chatFiles.messageId))
      .where(
        and(
          eq(chatFiles.id, id),
          eq(chatFiles.userId, this.userId),
          eq(messages.threadId, threadId),
        ),
      )
      .get();
    return row ? toContent(row.file) : null;
  }

  /** Files sent in a conversation, oldest first (without bytes). */
  listThread(threadId: string): (ChatFile & { messageId: string })[] {
    return this.db
      .select({
        id: chatFiles.id,
        messageId: messages.id,
        name: chatFiles.name,
        kind: chatFiles.kind,
        size: chatFiles.size,
        parts: chatFiles.partCount,
      })
      .from(chatFiles)
      .innerJoin(messages, eq(messages.id, chatFiles.messageId))
      .where(and(eq(chatFiles.userId, this.userId), eq(messages.threadId, threadId)))
      .orderBy(asc(messages.createdAt), asc(chatFiles.position))
      .all();
  }

  /** Gives the files to the question that carries them. */
  attach(messageId: string, ids: string[]) {
    ids.forEach((id, position) =>
      this.db
        .update(chatFiles)
        .set({ messageId, position })
        .where(and(eq(chatFiles.id, id), eq(chatFiles.userId, this.userId)))
        .run(),
    );
  }

  /** Files of the given messages, in order, by message id. */
  forMessages(messageIds: string[]): Map<string, ChatFile[]> {
    const out = new Map<string, ChatFile[]>();
    if (!messageIds.length) return out;
    const rows = this.db
      .select({
        id: chatFiles.id,
        messageId: chatFiles.messageId,
        name: chatFiles.name,
        kind: chatFiles.kind,
        size: chatFiles.size,
        parts: chatFiles.partCount,
      })
      .from(chatFiles)
      .where(and(eq(chatFiles.userId, this.userId), inArray(chatFiles.messageId, messageIds)))
      .orderBy(asc(chatFiles.position))
      .all();
    for (const { messageId, ...f } of rows) {
      const list = out.get(messageId!) ?? [];
      list.push(f);
      out.set(messageId!, list);
    }
    return out;
  }

  private dropUnsent() {
    const before = new Date(Date.now() - UNSENT_TTL_MS).toISOString();
    this.db
      .delete(chatFiles)
      .where(
        and(
          eq(chatFiles.userId, this.userId),
          isNull(chatFiles.messageId),
          lt(chatFiles.createdAt, before),
        ),
      )
      .run();
  }
}

function toContent(row: typeof chatFiles.$inferSelect): ChatFileContent {
  const texts = JSON.parse(row.partsJson) as string[];
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    size: row.size,
    parts: texts.length,
    data: row.data,
    texts,
  };
}
