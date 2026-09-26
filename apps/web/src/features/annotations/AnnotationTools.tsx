import clsx from 'clsx';
import {
  Eraser,
  MousePointer2,
  PenLine,
  Redo2,
  StickyNote,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect } from 'react';
import { t } from '../../i18n';
import { useReader, type AnnotationTool } from '../reader/store';
import { redo, undo, useAnnotationHistory } from './api';

const TOOLS: { id: AnnotationTool; icon: LucideIcon; label: string }[] = [
  { id: 'select', icon: MousePointer2, label: t.annotations.tools.select },
  { id: 'draw', icon: PenLine, label: t.annotations.tools.draw },
  { id: 'erase', icon: Eraser, label: t.annotations.tools.erase },
  { id: 'note', icon: StickyNote, label: t.annotations.tools.note },
];
const PEN_COLORS = ['#1f6feb', '#d1242f', '#1a7f37', '#1f1d1a', '#e8590c'];
const PEN_WIDTHS = [0.002, 0.004, 0.008];

const isTyping = (el: Element | null) =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  (el as HTMLElement | null)?.isContentEditable;

/** Undo/redo shortcuts (F-ANN-08): Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl+Y. */
export function useUndoShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || isTyping(document.activeElement)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        void undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Floating annotation toolbar: tools, pen options, undo/redo (optimised for tablets). */
export function AnnotationTools() {
  const tool = useReader((s) => s.tool);
  const setTool = useReader((s) => s.setTool);
  const pen = useReader((s) => s.pen);
  const setPen = useReader((s) => s.setPen);
  const canUndo = useAnnotationHistory((s) => s.past.length > 0 && !s.busy);
  const canRedo = useAnnotationHistory((s) => s.future.length > 0 && !s.busy);

  const btn = (active: boolean) =>
    clsx(
      'rounded-lg p-2',
      active ? 'bg-text text-bg' : 'text-text-muted hover:text-text hover:bg-surface-muted',
    );

  return (
    <div
      role="toolbar"
      aria-label={t.annotations.tools.label}
      className="border-border bg-surface/95 absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border p-1 shadow-lg backdrop-blur"
    >
      {TOOLS.map((x) => (
        <button
          key={x.id}
          type="button"
          aria-label={x.label}
          title={x.label}
          aria-pressed={tool === x.id}
          onClick={() => setTool(x.id)}
          className={btn(tool === x.id)}
        >
          <x.icon size={18} aria-hidden />
        </button>
      ))}
      {tool === 'draw' && (
        <>
          <span className="bg-border mx-1 h-6 w-px" aria-hidden />
          <div role="radiogroup" aria-label={t.annotations.tools.penColor} className="flex gap-1">
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={pen.color === c}
                aria-label={c}
                onClick={() => setPen({ color: c })}
                className={clsx(
                  'size-6 rounded-full ring-offset-1',
                  pen.color === c && 'ring-text ring-2',
                )}
                style={{ background: c }}
              />
            ))}
          </div>
          <div
            role="radiogroup"
            aria-label={t.annotations.tools.penWidth}
            className="ml-1 flex items-center gap-0.5"
          >
            {PEN_WIDTHS.map((w, i) => (
              <button
                key={w}
                type="button"
                role="radio"
                aria-checked={pen.width === w}
                aria-label={`${t.annotations.tools.penWidth} ${i + 1}`}
                onClick={() => setPen({ width: w })}
                className={clsx(
                  'flex size-7 items-center justify-center rounded-md',
                  pen.width === w && 'bg-surface-muted',
                )}
              >
                <span
                  className="bg-text rounded-full"
                  style={{ width: 4 + i * 4, height: 4 + i * 4 }}
                />
              </button>
            ))}
          </div>
        </>
      )}
      <span className="bg-border mx-1 h-6 w-px" aria-hidden />
      <button
        type="button"
        aria-label={t.annotations.tools.undo}
        title={t.annotations.tools.undo}
        disabled={!canUndo}
        onClick={() => void undo()}
        className={clsx(btn(false), 'disabled:opacity-30')}
      >
        <Undo2 size={18} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t.annotations.tools.redo}
        title={t.annotations.tools.redo}
        disabled={!canRedo}
        onClick={() => void redo()}
        className={clsx(btn(false), 'disabled:opacity-30')}
      >
        <Redo2 size={18} aria-hidden />
      </button>
    </div>
  );
}
