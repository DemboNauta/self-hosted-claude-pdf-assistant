/**
 * Highlighter tool: painting over a page turns the text from where the stroke started to
 * where it is now into a range, snapped to whole words, like a text selection made with
 * a pen (no long press needed on tablets).
 */

export interface Caret {
  node: Text;
  offset: number;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** The text position under a viewport point (whatever element it is in), if any. */
function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as CaretDocument;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** Text spans of a PDF.js text layer (the ones holding the text directly). */
function textSpans(layer: HTMLElement): { span: HTMLElement; text: Text }[] {
  const out: { span: HTMLElement; text: Text }[] = [];
  for (const span of layer.querySelectorAll<HTMLElement>('span')) {
    const first = span.firstChild;
    if (span.childNodes.length === 1 && first instanceof Text && first.length) {
      out.push({ span, text: first });
    }
  }
  return out;
}

/**
 * The caret in `layer` under (x, y). Between words or lines, where the browser finds no
 * text, it snaps to the nearest span (same line first). Elements covering the text layer
 * must let the point through (`pointer-events: none`) while this runs.
 */
export function caretInLayer(layer: HTMLElement, x: number, y: number): Caret | null {
  const hit = caretFromPoint(x, y);
  if (hit && hit.node instanceof Text && layer.contains(hit.node)) {
    return { node: hit.node, offset: hit.offset };
  }
  let best: { span: HTMLElement; text: Text; rect: DOMRect } | null = null;
  let bestDistance = Infinity;
  for (const { span, text } of textSpans(layer)) {
    const rect = span.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const distance = dy * 4 + dx;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { span, text, rect };
    }
  }
  if (!best) return null;
  const { text, rect } = best;
  if (x <= rect.left) return { node: text, offset: 0 };
  if (x >= rect.right) return { node: text, offset: text.length };
  const again = caretFromPoint(x, rect.top + rect.height / 2);
  if (again && again.node === text) return { node: text, offset: again.offset };
  return { node: text, offset: Math.round(((x - rect.left) / rect.width) * text.length) };
}

const isWordChar = (c: string | undefined) => c !== undefined && /\S/.test(c);

/** The range between two carets in reading order, widened to whole words. */
export function wordRange(a: Caret, b: Caret): Range {
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  let [start, end] = range.comparePoint(b.node, b.offset) < 0 ? [b, a] : [a, b];
  let so = start.offset;
  while (so > 0 && isWordChar(start.node.data[so - 1])) so--;
  let eo = end.offset;
  while (eo < end.node.length && isWordChar(end.node.data[eo])) eo++;
  start = { node: start.node, offset: so };
  end = { node: end.node, offset: eo };
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/**
 * The text of a range as it is quoted in anchors (collapsed white space). PDF.js ends
 * lines with `<br>`, which `Range.toString()` drops, so lines would run together.
 */
export function rangeText(range: Range): string {
  const root = range.commonAncestorContainer;
  if (root instanceof Text) return range.toString().replace(/\s+/g, ' ').trim();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let out = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    if (node instanceof Text) {
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : node.length;
      out += node.data.slice(from, to);
    } else if (node.nodeName === 'BR') out += ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}
