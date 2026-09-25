import type { NormRectDto } from '@pdfclaudeassistant/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pages } from '../db/schema.js';

type Item = [string, number, number, number, number];

const QUOTES: Record<string, string> = {
  '“': '"',
  '”': '"',
  '«': '"',
  '»': '"',
  '‘': "'",
  '’': "'",
  '‐': '-',
  '‑': '-',
  '–': '-',
  '—': '-',
};

/** Same canonical form as the web text matcher: no spaces, accents or case. */
export function canonical(ch: string): string {
  if (/\s|\u00ad/u.test(ch)) return '';
  return (QUOTES[ch] ?? ch).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function candidates(quote: string): string[] {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  const list = [quote];
  for (const n of [12, 8, 5]) if (words.length > n) list.push(words.slice(0, n).join(' '));
  return list;
}

/**
 * Finds `quote` in a page's stored text items and returns rectangles in normalised
 * page space. Positions inside an item are interpolated by character, which is exact
 * for monospaced runs and close enough for highlights elsewhere.
 */
export function quoteRects(items: Item[], quote: string, occurrence = 1): NormRectDto[] {
  let hay = '';
  const map: { item: number; char: number }[] = [];
  items.forEach(([str], i) => {
    [...str].forEach((ch, c) => {
      for (const k of canonical(ch)) {
        hay += k;
        map.push({ item: i, char: c });
      }
    });
  });
  for (const cand of candidates(quote)) {
    const needle = [...cand].map(canonical).join('');
    if (needle.length < 2) continue;
    let at = -1;
    for (let n = 0; n < occurrence; n++) {
      at = hay.indexOf(needle, at + 1);
      if (at < 0) break;
    }
    if (at < 0) continue;
    const spans = new Map<number, [number, number]>();
    for (const { item, char } of map.slice(at, at + needle.length)) {
      const cur = spans.get(item);
      spans.set(item, cur ? [cur[0], char] : [char, char]);
    }
    const rects: NormRectDto[] = [];
    for (const [i, [from, to]] of spans) {
      const [str, x, y, w, h] = items[i]!;
      const len = Math.max(1, [...str].length);
      rects.push({
        x: x + (w * from) / len,
        y,
        w: (w * (to - from + 1)) / len,
        h,
      });
    }
    return rects;
  }
  return [];
}

export function pageItems(db: Db, docId: string, page: number): Item[] {
  const row = db
    .select({ json: pages.textLayerJson })
    .from(pages)
    .where(and(eq(pages.documentId, docId), eq(pages.pageNumber, page)))
    .get();
  return row ? (JSON.parse(row.json) as Item[]) : [];
}
