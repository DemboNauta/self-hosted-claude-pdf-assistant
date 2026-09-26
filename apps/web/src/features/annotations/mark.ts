import type { Annotation, DrawingMark } from '@pdfclaudeassistant/shared';
import { queryClient } from '../../lib/queryClient';
import { useChatDock } from '../chat/ChatDock';
import { useChat } from '../chat/store';
import type { NormRect } from '../reader/textMatch';
import { boxOf } from './AnnotationLayer';
import { annotationsKey } from './api';

/** Margin around the drawings, so what they circle or point at is inside the area. */
const PAD = 0.03;

/**
 * The area covered by some drawings on a page and the text inside it, read from the
 * rendered text layer (a line counts when its centre falls inside the area).
 */
export function buildMark(docId: string, page: number, ids: string[]): DrawingMark | null {
  const list = queryClient.getQueryData<Annotation[]>(annotationsKey(docId)) ?? [];
  const drawings = list.filter(
    (a) => a.type === 'drawing' && a.page === page && ids.includes(a.id),
  );
  const boxes = drawings.map(boxOf).filter((b): b is NormRect => b !== null);
  if (!boxes.length) return null;
  const x1 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - PAD);
  const y1 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - PAD);
  const x2 = Math.min(1, Math.max(...boxes.map((b) => b.x + b.w)) + PAD);
  const y2 = Math.min(1, Math.max(...boxes.map((b) => b.y + b.h)) + PAD);
  const rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  return {
    page,
    rect,
    annotationIds: drawings.map((a) => a.id),
    text: textInside(page, rect).slice(0, 8000),
  };
}

function textInside(page: number, r: NormRect): string {
  const pageEl = document.querySelector<HTMLElement>(`[data-page="${page}"]`);
  if (!pageEl) return '';
  const box = pageEl.getBoundingClientRect();
  const spans = [...pageEl.querySelectorAll<HTMLElement>('.textLayer span')].filter((s) => {
    const b = s.getBoundingClientRect();
    if (!b.width || !b.height) return false;
    const cx = (b.left + b.width / 2 - box.left) / box.width;
    const cy = (b.top + b.height / 2 - box.top) / box.height;
    return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
  });
  return spans
    .map((s) => s.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Attaches the marked area to the next chat question and opens the chat to type it. */
export function askAboutMark(docId: string, page: number, ids: string[]): boolean {
  const mark = buildMark(docId, page, ids);
  if (!mark) return false;
  useChat.getState().attachMark(mark);
  useChatDock.getState().show();
  setTimeout(() => window.dispatchEvent(new CustomEvent('pca:focus-composer')), 50);
  return true;
}
