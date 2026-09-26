import type { Annotation, AnnotationDisplay } from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { Check, MessageSquare, Pin, PinOff, Trash2, X } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n';
import { useChatDock } from '../chat/ChatDock';
import { useChat } from '../chat/store';
import type { NormRect } from '../reader/textMatch';
import {
  deleteAnnotations,
  setProposalStatus,
  updateAnnotation,
  updateDisplay,
  usePalette,
} from './api';
import { MIN_H, MIN_W, usePopoverSize } from './popoverSize';

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const KEY_STEP = 24;
const NO_DISPLAY: AnnotationDisplay = { pinned: false, x: null, y: null, w: null, h: null };

/** Window geometry while the user drags or resizes it (px, relative to the page). */
interface Live {
  left: number;
  top: number;
  w: number;
  h: number | null;
}

/**
 * Note window of an annotation: colour, comment, delete; accept/discard proposals.
 * Floats on the page next to the annotation. It can be moved (drag the header), resized
 * (corner handle or arrow keys on it) and pinned so it stays open; all of that is saved
 * with the annotation. On phones an unpinned window is a bottom sheet instead.
 */
export function AnnotationPopover({
  docId,
  annotation: a,
  box,
  pageWidth,
  pageHeight,
  focused,
  onFocus,
  onClose,
  extraActions,
}: {
  docId: string;
  annotation: Annotation;
  box: NormRect | null;
  pageWidth: number;
  pageHeight: number;
  /** The window the user is working with (drawn above the others). */
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  /** More buttons for the footer (e.g. asking Claude about a drawing). */
  extraActions?: ReactNode;
}) {
  const { palette, colorOf } = usePalette();
  const { layout, size: defaultSize, setSize: setDefaultSize, reset } = usePopoverSize();
  const display = a.display ?? NO_DISPLAY;
  const sheet = layout === 'phone' && !display.pinned;
  const [text, setText] = useState(a.content ?? '');
  const [live, setLive] = useState<Live | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ kind: 'move' | 'resize'; x: number; y: number; start: Live } | null>(
    null,
  );
  const quote = (a.anchor as { quote?: string }).quote;
  const proposal = a.status === 'proposed';
  const editable = a.type === 'highlight' || a.type === 'note';

  const w = live?.w ?? display.w ?? (defaultSize.w || 360);
  // Windows without text to show (a drawing's) just fit their buttons.
  const h = !editable && !proposal ? null : live ? live.h : (display.h ?? defaultSize.h);

  useEffect(() => {
    if (a.type === 'note' && !a.content && focused) area.current?.focus();
  }, [a.type, a.content, focused]);

  // Without a set height the comment box grows with its text, up to 40% of the screen.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    if (h !== null) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.4)}px`;
  }, [text, h, layout]);

  const saveText = () => {
    const content = text.trim() || null;
    if (content !== (a.content ?? null)) void updateAnnotation(docId, a, { content });
  };

  const saveDisplay = (patch: Partial<AnnotationDisplay>) =>
    void updateDisplay(docId, a.id, { ...display, ...patch });

  /** Current geometry of the floating window, in px relative to the page. */
  const geometry = (): Live | null => {
    const el = panel.current;
    if (!el) return null;
    return { left: el.offsetLeft, top: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  };

  const maxW = Math.max(MIN_W, pageWidth - 8);
  const maxH = () => window.innerHeight * (sheet ? 0.9 : 0.85);

  /** Starts moving (header) or resizing (handle), told apart by `data-gesture`. */
  const onGestureStart = (e: PointerEvent<HTMLElement>) => {
    const kind = e.currentTarget.dataset.gesture === 'move' ? 'move' : 'resize';
    if (kind === 'move' && (e.target as HTMLElement).closest('button')) return;
    const start = geometry();
    if (!start) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { kind, x: e.clientX, y: e.clientY, start };
  };
  const onGestureMove = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const s = g.start;
    if (g.kind === 'move') {
      setLive({
        ...s,
        h: display.h ?? defaultSize.h,
        left: clamp(s.left + dx, 0, pageWidth - Math.min(s.w, pageWidth)),
        top: clamp(s.top + dy, 0, Math.max(0, pageHeight - 32)),
      });
    } else if (sheet) {
      // The phone sheet grows upwards from the bottom edge.
      setLive({ ...s, h: clamp(s.h! - dy, MIN_H, maxH()) });
    } else {
      setLive({ ...s, w: clamp(s.w + dx, MIN_W, maxW), h: clamp(s.h! + dy, MIN_H, maxH()) });
    }
  };
  const onGestureEnd = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || !live) return;
    setLive(null);
    if (g.kind === 'move') {
      saveDisplay({ x: live.left / pageWidth, y: live.top / pageHeight });
    } else {
      const size = { w: Math.round(live.w), h: live.h === null ? null : Math.round(live.h) };
      setDefaultSize(size);
      saveDisplay(sheet ? { h: size.h } : size);
    }
  };

  const onResizeKey = (e: KeyboardEvent<HTMLElement>) => {
    const s = geometry();
    if (!s) return;
    const grow = sheet ? -KEY_STEP : KEY_STEP;
    const next: Record<string, { w: number; h: number }> = {
      ArrowRight: { w: s.w + KEY_STEP, h: s.h! },
      ArrowLeft: { w: s.w - KEY_STEP, h: s.h! },
      ArrowDown: { w: s.w, h: s.h! + grow },
      ArrowUp: { w: s.w, h: s.h! - grow },
    };
    const n = next[e.key];
    if (n) {
      e.preventDefault();
      const size = {
        w: Math.round(clamp(n.w, MIN_W, maxW)),
        h: Math.round(clamp(n.h, MIN_H, maxH())),
      };
      setDefaultSize(size);
      saveDisplay(sheet ? { h: size.h } : size);
    } else if (e.key === 'Home') {
      e.preventDefault();
      resetSize();
    }
  };
  const resetSize = () => {
    reset();
    saveDisplay({ w: null, h: null });
  };

  const gestureProps = {
    onPointerDown: onGestureStart,
    onPointerMove: onGestureMove,
    onPointerUp: onGestureEnd,
    onPointerCancel: onGestureEnd,
    style: { touchAction: 'none' as const },
  };
  const resizeProps = {
    ...gestureProps,
    'data-gesture': 'resize',
    role: 'separator',
    tabIndex: 0,
    'aria-label': t.annotations.resize,
    title: t.annotations.resizeHint,
    onDoubleClick: resetSize,
    onKeyDown: onResizeKey,
  };

  // Placement: where the user left it, else below (or above) the annotation.
  const width = `min(${w}px, calc(100% - 8px))`;
  const placed = display.x !== null && display.y !== null;
  const below = (box ? box.y + box.h : 0.1) < 0.75;
  const position = live
    ? { left: live.left, top: live.top }
    : placed
      ? { left: `${display.x! * 100}%`, top: `${display.y! * 100}%` }
      : {
          left: `clamp(4px, ${(box?.x ?? 0.5) * 100}%, calc(100% - ${width} - 4px))`,
          ...(below
            ? { top: `calc(${((box?.y ?? 0) + (box?.h ?? 0.1)) * 100}% + 8px)` }
            : { bottom: `calc(${(1 - (box?.y ?? 0.9)) * 100}% + 8px)` }),
        };
  const floatingStyle = {
    width,
    ...position,
    ...(h !== null ? { height: h } : { maxHeight: '85vh' }),
  };
  const sheetStyle = {
    ...(h !== null ? { height: h } : { maxHeight: '70vh' }),
    paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
  };

  // Pinning on a phone turns the sheet into a window on the page, next to the annotation.
  const togglePin = () => saveDisplay({ pinned: !display.pinned });
  const close = () => {
    if (display.pinned) saveDisplay({ pinned: false });
    onClose();
  };

  const body = (
    <div
      ref={panel}
      data-annotation-ui
      data-testid="annotation-popover"
      data-annotation-window={a.id}
      data-layout={sheet ? 'sheet' : 'window'}
      data-pinned={display.pinned || undefined}
      role="dialog"
      aria-label={t.annotations.edit}
      onClick={(e) => e.stopPropagation()}
      onPointerDownCapture={() => !focused && onFocus()}
      onKeyDown={(e) => e.key === 'Escape' && close()}
      className={clsx(
        'border-border bg-surface text-text flex flex-col border shadow-xl',
        sheet
          ? 'fixed inset-x-0 bottom-0 z-50 rounded-t-2xl px-4 pt-1 text-base'
          : clsx('absolute rounded-xl p-3 pr-4 pb-4 text-sm', focused ? 'z-40' : 'z-30'),
        display.pinned && !sheet && 'ring-accent/40 ring-1',
      )}
      style={sheet ? sheetStyle : floatingStyle}
    >
      {sheet && (
        <div {...resizeProps} className="-mx-4 flex cursor-ns-resize justify-center py-2">
          <span aria-hidden className="bg-border h-1.5 w-10 rounded-full" />
        </div>
      )}
      <div
        {...(sheet ? {} : { ...gestureProps, 'data-gesture': 'move' })}
        title={sheet ? undefined : t.annotations.moveHint}
        className={clsx(
          'mb-2 flex shrink-0 items-center gap-1 select-none',
          !sheet && '-mx-3 -mt-3 cursor-move px-3 pt-3',
        )}
      >
        <span className="text-text-muted flex-1 truncate text-xs">
          {a.author === 'claude' ? t.annotations.byClaude : t.annotations.byYou} · p. {a.page}
        </span>
        <button
          type="button"
          onClick={togglePin}
          aria-pressed={display.pinned}
          aria-label={display.pinned ? t.annotations.unpin : t.annotations.pin}
          title={display.pinned ? t.annotations.unpin : t.annotations.pin}
          className={clsx(
            'rounded p-1',
            display.pinned ? 'text-accent' : 'text-text-muted hover:text-text',
          )}
        >
          {display.pinned ? (
            <PinOff size={sheet ? 18 : 14} aria-hidden />
          ) : (
            <Pin size={sheet ? 18 : 14} aria-hidden />
          )}
        </button>
        <button
          type="button"
          onClick={close}
          aria-label={t.reader.closePanel}
          className="text-text-muted hover:text-text rounded p-1"
        >
          <X size={sheet ? 18 : 14} aria-hidden />
        </button>
      </div>

      {proposal ? (
        <>
          {a.content && (
            <p className="mb-3 min-h-0 flex-1 overflow-y-auto leading-relaxed whitespace-pre-wrap">
              {a.content}
            </p>
          )}
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => {
                void setProposalStatus(docId, [a.id], 'active');
                onClose();
              }}
              className="bg-accent text-accent-contrast flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5"
            >
              <Check size={14} aria-hidden />
              {t.annotations.accept}
            </button>
            <button
              type="button"
              onClick={() => {
                void setProposalStatus(docId, [a.id], 'rejected');
                onClose();
              }}
              className="border-border flex-1 rounded-lg border px-2 py-1.5"
            >
              {t.annotations.reject}
            </button>
          </div>
        </>
      ) : (
        <>
          {editable && (
            <div
              role="radiogroup"
              aria-label={t.annotations.color}
              className="mb-2 flex shrink-0 gap-1.5"
            >
              {palette.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={a.color === p.key}
                  aria-label={p.meaning}
                  title={p.meaning}
                  onClick={() => void updateAnnotation(docId, a, { color: p.key })}
                  className={clsx(
                    'rounded-full ring-offset-2',
                    sheet ? 'size-8' : 'size-6',
                    a.color === p.key && 'ring-text ring-2',
                  )}
                  style={{ background: colorOf(p.key) }}
                />
              ))}
            </div>
          )}
          {editable && (
            <textarea
              ref={area}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={saveText}
              rows={4}
              placeholder={
                a.type === 'note' ? t.annotations.notePlaceholder : t.annotations.commentPlaceholder
              }
              aria-label={t.annotations.comment}
              className={clsx(
                'border-border bg-bg mb-2 w-full resize-none rounded-lg border px-2.5 py-2 leading-relaxed',
                h !== null ? 'min-h-16 flex-1' : 'min-h-24',
              )}
            />
          )}
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {quote && (
              <button
                type="button"
                onClick={() => {
                  useChat.getState().attach({ page: a.page, text: quote });
                  useChatDock.getState().show();
                  onClose();
                }}
                className="hover:bg-surface-muted flex items-center gap-1 rounded-md px-2 py-1"
              >
                <MessageSquare size={14} aria-hidden />
                {t.chat.selection.ask}
              </button>
            )}
            {extraActions}
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => {
                void deleteAnnotations(docId, [a]);
                onClose();
              }}
              aria-label={t.annotations.delete}
              title={t.annotations.delete}
              className="text-danger hover:bg-surface-muted rounded-md p-1.5"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        </>
      )}
      {!sheet && (
        <span
          {...resizeProps}
          className="text-text-muted hover:text-text absolute right-0 bottom-0 flex size-5 cursor-nwse-resize items-end justify-end rounded-br-xl p-1"
        >
          <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" stroke="currentColor">
            <path d="M9 1L1 9M9 5L5 9" strokeLinecap="round" />
          </svg>
        </span>
      )}
    </div>
  );

  if (sheet) return createPortal(body, document.body);

  // A moved window keeps a thin line to its annotation so it is clear what it belongs to.
  const anchorPt = box && {
    x: (box.x + box.w / 2) * pageWidth,
    y: (box.y + box.h / 2) * pageHeight,
  };
  const winPt = live
    ? { x: live.left, y: live.top }
    : placed
      ? { x: display.x! * pageWidth, y: display.y! * pageHeight }
      : null;
  return (
    <>
      {anchorPt && winPt && (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 overflow-visible"
          width={pageWidth}
          height={pageHeight}
        >
          <line
            x1={anchorPt.x}
            y1={anchorPt.y}
            x2={clamp(anchorPt.x, winPt.x, winPt.x + Math.min(w, pageWidth - 8))}
            y2={winPt.y + 12}
            stroke={colorOf(a.color)}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <circle cx={anchorPt.x} cy={anchorPt.y} r={3} fill={colorOf(a.color)} />
        </svg>
      )}
      {body}
    </>
  );
}
