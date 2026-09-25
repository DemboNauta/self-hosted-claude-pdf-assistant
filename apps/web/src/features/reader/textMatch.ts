/** Rectangle in normalised page space (0–1, top-left origin), like stored anchors. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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

/**
 * Canonical form used to compare quotes with the text layer: compatibility-decomposed
 * (ligatures → letters), no diacritics, lower case, unified quotes/dashes, and no
 * whitespace at all, because PDF text runs rarely keep the original spacing.
 */
export function canonicalChars(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    for (const c of normaliseChar(ch)) out.push(c);
  }
  return out;
}

function normaliseChar(ch: string): string {
  if (/\s|\u00ad/u.test(ch)) return '';
  const mapped = QUOTES[ch] ?? ch;
  return mapped.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

interface Pos {
  node: Text;
  offset: number;
}

/** Canonical text of a text layer plus, for each canonical char, where it came from. */
function indexLayer(layer: HTMLElement) {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('.endOfContent')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let hay = '';
  const map: Pos[] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const text = node.data;
    let offset = 0;
    for (const ch of text) {
      for (const c of normaliseChar(ch)) {
        hay += c;
        map.push({ node, offset });
      }
      offset += ch.length;
    }
  }
  return { hay, map };
}

/** Candidate needles: the full quote, then shorter word prefixes (Claude may paraphrase the tail). */
function candidates(quote: string): string[] {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  const list = [quote];
  for (const n of [12, 8, 5]) if (words.length > n) list.push(words.slice(0, n).join(' '));
  return list;
}

/**
 * Finds `quote` in a rendered PDF.js text layer and returns, for each occurrence, its
 * rectangles relative to `page`. Matching ignores case, accents, spacing and quote style.
 */
export function findQuoteRects(
  layer: HTMLElement,
  page: HTMLElement,
  quote: string,
  { all = false }: { all?: boolean } = {},
): NormRect[][] {
  const { hay, map } = indexLayer(layer);
  if (!hay) return [];
  const box = page.getBoundingClientRect();
  if (!box.width || !box.height) return [];

  for (const candidate of candidates(quote)) {
    const needle = canonicalChars(candidate).join('');
    if (needle.length < 2) continue;
    const found: NormRect[][] = [];
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
      // One range per text node: a range spanning elements would also report the
      // boxes of the spans it fully contains.
      const spans = new Map<Text, [number, number]>();
      for (const { node, offset } of map.slice(at, at + needle.length)) {
        const cur = spans.get(node);
        spans.set(node, cur ? [cur[0], offset] : [offset, offset]);
      }
      const rects: NormRect[] = [];
      for (const [node, [from, to]] of spans) {
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, Math.min(node.length, to + 1));
        for (const r of range.getClientRects()) {
          if (r.width <= 0 || r.height <= 0) continue;
          rects.push({
            x: (r.left - box.left) / box.width,
            y: (r.top - box.top) / box.height,
            w: r.width / box.width,
            h: r.height / box.height,
          });
        }
      }
      if (rects.length) found.push(rects);
      if (!all) break;
    }
    if (found.length) return found;
  }
  return [];
}
