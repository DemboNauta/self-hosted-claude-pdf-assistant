import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type SearchHit,
  type SearchQuery,
} from '@pdfclaudeassistant/shared';
import type { Db } from '../db/client.js';
import { HttpError } from './errors.js';

/**
 * Turns free text into a safe FTS5 query: every word becomes a quoted prefix term,
 * so punctuation or FTS operators typed by the user (or Claude) cannot break it.
 */
export function toFtsQuery(text: string): string | null {
  const words = text.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  return words
    .slice(0, 12)
    .map((w) => `"${w}"*`)
    .join(' ');
}

interface Row {
  docId: string;
  title: string;
  page: number;
  snippet: string;
}

/** Full-text search over page text (F-VIS-02, F-SRC-01, `search_library`). */
export class SearchService {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  search({ q, scope, id, limit }: SearchQuery): SearchHit[] {
    const match = toFtsQuery(q);
    if (!match) return [];
    if (scope !== 'all' && !id) throw new HttpError(400, 'invalid_request');

    const filter = {
      all: '',
      doc: 'AND d.id = @id',
      topic: 'AND d.topic_id = @id',
      subject: 'AND d.topic_id IN (SELECT id FROM topics WHERE subject_id = @id)',
    }[scope];
    const rows = this.db.$client
      .prepare(
        `SELECT d.id AS docId, d.title AS title, p.page_number AS page,
                snippet(pages_fts, 0, @start, @end, '…', 16) AS snippet
           FROM pages_fts
           JOIN pages p ON p.id = pages_fts.rowid
           JOIN documents d ON d.id = p.document_id
          WHERE pages_fts MATCH @match AND d.user_id = @userId AND d.deleted_at IS NULL ${filter}
          ORDER BY ${scope === 'doc' ? 'p.page_number' : 'rank'}
          LIMIT @limit`,
      )
      .all({
        match,
        limit,
        userId: this.userId,
        start: SEARCH_MARK_START,
        end: SEARCH_MARK_END,
        ...(scope === 'all' ? {} : { id }),
      });
    return rows as Row[];
  }
}
