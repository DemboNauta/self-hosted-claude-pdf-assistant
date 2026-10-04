import { CLAUDE_COLOR, type Annotation } from '@pdfclaudeassistant/shared';
import { Check, ChevronRight, MessageSquareText, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import type { PageLayers } from '../reader/PdfPage';
import { setProposalStatus } from './api';
import { NoteMedia } from './NoteMedia';

const GAP = 12;
const MAX_W = 240;
const MIN_OUTSIDE = 160;
const INSIDE_W = 220;
/** Inside the page, keep clear of the question badges at its right edge (QuestionMarks). */
const BADGE_LANE = 36;

/** Claude's proposed margin notes: text notes by Claude still waiting for the student. */
export function isMarginNote(a: Annotation) {
  return (
    a.author === 'claude' &&
    a.type === 'note' &&
    a.status === 'proposed' &&
    (a.anchor as { kind?: string }).kind === 'text'
  );
}

/**
 * Claude's comments written next to the passage they explain (F-ANN-04). They sit in
 * the free space right of the page when there is room (desktop), or over the page's
 * right edge otherwise, stacked so they never overlap. Accepting turns one into a
 * regular note; discarding removes it.
 */
export function MarginNotes({
  docId,
  notes,
  layers,
  width,
  height,
  boxOf,
}: {
  docId: string;
  notes: Annotation[];
  layers: PageLayers;
  width: number;
  height: number;
  boxOf: (a: Annotation) => { x: number; y: number; w: number; h: number } | null;
}) {
  // Free space right of the page (pages are centred in the scroller).
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = layers.pageEl;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const measure = () => setRoom(parent.clientWidth - el.offsetLeft - el.offsetWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [layers.pageEl, width]);

  const outside = room - 2 * GAP >= MIN_OUTSIDE;
  const [open, setOpen] = useState<string | null>(null);
  const cardW = outside
    ? Math.min(MAX_W, room - 2 * GAP)
    : Math.min(INSIDE_W, width - BADGE_LANE - 8);
  const left = outside ? width + GAP : width - cardW - BADGE_LANE;

  const items = notes
    .map((a) => ({ a, box: boxOf(a) }))
    .filter((n): n is { a: Annotation; box: NonNullable<typeof n.box> } => n.box !== null)
    .sort((p, q) => p.box.y - q.box.y);

  // Stack the cards once their heights are known: each starts at its passage or right
  // below the previous card. Written straight to the DOM (a measure-then-place pass).
  const cards = useRef(new Map<string, HTMLElement>());
  const leaders = useRef(new Map<string, SVGPathElement>());
  const key = items
    .map((n) => `${n.a.id}:${n.box.y}:${n.a.content?.length}:${n.a.images.length}:${!!n.a.board}`)
    .join('|');
  useLayoutEffect(() => {
    let bottom = -Infinity;
    for (const { a, box } of items) {
      const card = cards.current.get(a.id);
      if (!card) continue;
      const top = Math.max(box.y * height - 4, bottom + 8);
      card.style.top = `${top}px`;
      bottom = top + card.offsetHeight;
      const from = `M${(box.x + box.w) * width + 2},${(box.y + box.h / 2) * height}`;
      leaders.current.get(a.id)?.setAttribute('d', `${from} L${width + GAP},${top + 14}`);
    }
    // `key` captures what changes the layout; `items` is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, width, height, cardW, outside, open]);

  if (!items.length) return null;
  return (
    <>
      {outside && (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={width}
          height={height}
        >
          {items.map(({ a }) => (
            <path
              key={a.id}
              ref={(el) => {
                if (el) leaders.current.set(a.id, el);
                else leaders.current.delete(a.id);
              }}
              stroke={CLAUDE_COLOR}
              strokeWidth={1}
              strokeDasharray="3 3"
              fill="none"
              opacity={0.6}
            />
          ))}
        </svg>
      )}
      {items.map(({ a, box }) => {
        const place = (el: HTMLElement | null) => {
          if (el) cards.current.set(a.id, el);
          else cards.current.delete(a.id);
        };
        // No free margin (phones, fit-width): folded into a small tab until tapped.
        if (!outside && open !== a.id) {
          return (
            <button
              key={a.id}
              ref={place}
              type="button"
              data-annotation-ui
              aria-label={t.annotations.openMarginNote}
              title={t.annotations.openMarginNote}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(a.id);
              }}
              className="bg-surface absolute z-10 flex size-6 items-center justify-center rounded-md border-2 shadow"
              style={{
                left: width - BADGE_LANE - 28,
                top: box.y * height,
                borderColor: CLAUDE_COLOR,
                color: CLAUDE_COLOR,
              }}
            >
              <MessageSquareText size={13} aria-hidden />
            </button>
          );
        }
        return (
          <div
            key={a.id}
            ref={place}
            role="note"
            aria-label={t.annotations.marginNote}
            data-annotation-ui
            data-margin-note={a.id}
            className="bg-surface text-text border-border absolute z-10 flex items-start gap-1 rounded-md border border-l-4 py-1.5 pr-1 pl-2.5 text-xs leading-snug shadow-md"
            style={{
              left,
              top: box.y * height,
              width: cardW,
              borderLeftColor: CLAUDE_COLOR,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="min-w-0 flex-1 py-0.5">
              <p className="whitespace-pre-wrap">{a.content}</p>
              {(a.board || a.images.length > 0) && (
                <div className="mt-1.5 -mb-2">
                  <NoteMedia docId={docId} annotation={a} editable={false} compact />
                </div>
              )}
            </div>
            <div className="flex shrink-0">
              <button
                type="button"
                aria-label={t.annotations.rejectNote}
                title={t.annotations.rejectNote}
                onClick={() => void setProposalStatus(docId, [a.id], 'rejected')}
                className="text-text-muted hover:text-text hover:bg-surface-muted rounded p-1"
              >
                <X size={14} aria-hidden />
              </button>
              <button
                type="button"
                aria-label={t.annotations.acceptNote}
                title={t.annotations.acceptNote}
                onClick={() => void setProposalStatus(docId, [a.id], 'active')}
                className="hover:bg-surface-muted rounded p-1"
                style={{ color: CLAUDE_COLOR }}
              >
                <Check size={14} aria-hidden />
              </button>
              {!outside && (
                <button
                  type="button"
                  aria-label={t.annotations.foldMarginNote}
                  title={t.annotations.foldMarginNote}
                  onClick={() => setOpen(null)}
                  className="text-text-muted hover:text-text hover:bg-surface-muted rounded p-1"
                >
                  <ChevronRight size={14} aria-hidden />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
