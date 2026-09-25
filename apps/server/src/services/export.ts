import fs from 'node:fs';
import {
  CLAUDE_COLOR,
  CLAUDE_COLOR_KEY,
  type Annotation,
  type DrawingAnchor,
  type HighlightAnchor,
  type NormRectDto,
  type NoteAnchor,
  type PaletteEntry,
  type ShapeAnchor,
} from '@pdfclaudeassistant/shared';
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFPage } from 'pdf-lib';

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1]!, 16) : 0xf7d33d;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function colorOf(key: string, palette: PaletteEntry[]): string {
  if (key === CLAUDE_COLOR_KEY) return CLAUDE_COLOR;
  return palette.find((p) => p.key === key)?.color ?? (key.startsWith('#') ? key : '#f7d33d');
}

/**
 * Writes the annotations as standard PDF annotations (Highlight, Text, Ink, Square,
 * Circle) into a copy of the original (F-ANN-06), so other readers show them. The
 * stored PDF is never modified.
 */
export async function exportAnnotatedPdf(
  filePath: string,
  items: Annotation[],
  palette: PaletteEntry[],
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(await fs.promises.readFile(filePath), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const pages = pdf.getPages();

  for (const a of items) {
    if (a.status !== 'active') continue;
    const page = pages[a.page - 1];
    if (!page) continue;
    const { width, height } = page.getSize();
    // Normalised (top-left origin) → PDF user space (bottom-left origin).
    const box = (r: NormRectDto) => ({
      x1: r.x * width,
      y1: height - (r.y + r.h) * height,
      x2: (r.x + r.w) * width,
      y2: height - r.y * height,
    });
    const color = hexToRgb(colorOf(a.color, palette));
    const author = a.author === 'claude' ? 'Claude' : 'PdfClaudeAssistant';
    const common = {
      C: color,
      T: PDFHexString.fromText(author),
      M: PDFHexString.fromText(`D:${a.updatedAt.replace(/\D/g, '').slice(0, 14)}Z`),
      F: 4,
      ...(a.content ? { Contents: PDFHexString.fromText(a.content) } : {}),
    };

    if (
      a.type === 'highlight' ||
      (a.type === 'note' && (a.anchor as NoteAnchor & { kind: string }).kind === 'text')
    ) {
      const rects = (a.anchor as HighlightAnchor).rects ?? [];
      if (!rects.length) continue;
      const boxes = rects.map(box);
      const quad = boxes.flatMap((b) => [b.x1, b.y2, b.x2, b.y2, b.x1, b.y1, b.x2, b.y1]);
      addAnnot(pdf, page, {
        Subtype: 'Highlight',
        Rect: bounds(boxes),
        QuadPoints: quad,
        CA: 0.5,
        ...common,
      });
    }
    if (a.type === 'note') {
      const anchor = a.anchor as NoteAnchor;
      const at =
        anchor.kind === 'point'
          ? { x: anchor.x * width, y: height - anchor.y * height }
          : (() => {
              const b = bounds((anchor.rects ?? []).map(box));
              return { x: b[2], y: b[3] };
            })();
      addAnnot(pdf, page, {
        Subtype: 'Text',
        Rect: [at.x, at.y - 20, at.x + 20, at.y],
        Name: 'Comment',
        Open: false,
        ...common,
      });
    }
    if (a.type === 'drawing') {
      const strokes = (a.anchor as DrawingAnchor).strokes;
      const lists = strokes.map((s) =>
        s.points.flatMap(([x, y]) => [x * width, height - y * height]),
      );
      const xs = lists.flatMap((l) => l.filter((_, i) => i % 2 === 0));
      const ys = lists.flatMap((l) => l.filter((_, i) => i % 2 === 1));
      addAnnot(pdf, page, {
        Subtype: 'Ink',
        Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        InkList: lists,
        BS: { W: Math.max(1, (strokes[0]?.width ?? 0.003) * width) },
        ...common,
        C: hexToRgb(strokes[0]?.color ?? '#000000'),
      });
    }
    if (a.type === 'shape') {
      const s = a.anchor as ShapeAnchor;
      const boxes = s.rects.map(box);
      const b = bounds(boxes);
      if (s.shape === 'highlight') {
        addAnnot(pdf, page, {
          Subtype: 'Highlight',
          Rect: b,
          QuadPoints: boxes.flatMap((q) => [q.x1, q.y2, q.x2, q.y2, q.x1, q.y1, q.x2, q.y1]),
          CA: 0.4,
          ...common,
        });
      } else {
        const pad = 4;
        addAnnot(pdf, page, {
          Subtype: s.shape === 'circle' ? 'Circle' : 'Square',
          Rect: [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad],
          BS: { W: 1.5 },
          ...common,
        });
      }
    }
  }
  return pdf.save();
}

function bounds(
  boxes: { x1: number; y1: number; x2: number; y2: number }[],
): [number, number, number, number] {
  return [
    Math.min(...boxes.map((b) => b.x1)),
    Math.min(...boxes.map((b) => b.y1)),
    Math.max(...boxes.map((b) => b.x2)),
    Math.max(...boxes.map((b) => b.y2)),
  ];
}

function addAnnot(pdf: PDFDocument, page: PDFPage, dict: Record<string, unknown>) {
  const annot = pdf.context.obj({ Type: 'Annot', ...toPdf(dict) } as never);
  const ref = pdf.context.register(annot);
  let annots = page.node.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) {
    annots = pdf.context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  (annots as PDFArray).push(ref);
}

/** pdf-lib's `obj` turns strings into names; keep numbers, arrays and nested dicts. */
function toPdf(dict: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v === 'number') out[k] = PDFNumber.of(v);
    else if (Array.isArray(v)) out[k] = v;
    else if (typeof v === 'object' && v && !(v instanceof PDFHexString))
      out[k] = toPdf(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}
