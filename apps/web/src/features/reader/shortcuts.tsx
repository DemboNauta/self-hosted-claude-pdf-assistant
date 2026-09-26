import { HIGHLIGHT_KEYS } from '@pdfclaudeassistant/shared';
import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { t } from '../../i18n';
import { createAnnotations } from '../annotations/api';
import { useChatDock } from '../chat/ChatDock';
import { requestZoom } from './PdfViewer';
import { readSelection } from './SelectionMenu';
import { useReader, ZOOM_STEPS } from './store';

const isTyping = (el: Element | null) =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  (el as HTMLElement | null)?.isContentEditable === true;

export const SHORTCUTS: [string, string][] = [
  ['j / k', t.shortcuts.nextPrev],
  ['g', t.shortcuts.goTo],
  ['+ / −', t.shortcuts.zoom],
  ['0', t.shortcuts.fitWidth],
  ['1 – 5', t.shortcuts.highlight],
  ['c', t.shortcuts.chat],
  ['/', t.shortcuts.search],
  ['t', t.shortcuts.thumbnails],
  ['i', t.shortcuts.outline],
  ['a', t.shortcuts.annotations],
  ['m', t.shortcuts.memory],
  ['d', t.shortcuts.draw],
  ['Esc', t.shortcuts.escape],
  ['Ctrl + Z / Ctrl + Shift + Z', t.shortcuts.undo],
  ['?', t.shortcuts.help],
];

/** Desktop keyboard shortcuts in the reader (F-UX-03). */
export function useReaderShortcuts(docId: string, scroller: HTMLElement | null) {
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(document.activeElement)) return;
      const r = useReader.getState();
      const page = (delta: number) => r.goTo(r.currentPage + delta);
      const zoom = (dir: 1 | -1) => {
        const next =
          dir > 0
            ? ZOOM_STEPS.find((z) => z > r.scale + 0.01)
            : [...ZOOM_STEPS].reverse().find((z) => z < r.scale - 0.01);
        if (next) requestZoom(next);
      };
      const handled = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      switch (e.key) {
        case 'j':
          return handled(() => page(1));
        case 'k':
          return handled(() => page(-1));
        case 'g':
          return handled(() =>
            document
              .querySelector<HTMLInputElement>(`input[aria-label="${t.reader.page}"]`)
              ?.focus(),
          );
        case '+':
        case '=':
          return handled(() => zoom(1));
        case '-':
          return handled(() => zoom(-1));
        case '0':
          return handled(() => r.setZoom('fit-width'));
        case 'c':
          return handled(() => useChatDock.getState().toggle());
        case '/':
          return handled(() => r.togglePanel('search'));
        case 't':
          return handled(() => r.togglePanel('thumbnails'));
        case 'i':
          return handled(() => r.togglePanel('outline'));
        case 'a':
          return handled(() => r.togglePanel('annotations'));
        case 'm':
          return handled(() => r.togglePanel('memory'));
        case 'd':
          return handled(() => r.setTool(r.tool === 'draw' ? 'select' : 'draw'));
        case 'Escape':
          if (r.tool !== 'select') return handled(() => r.setTool('select'));
          if (r.activeAnnotation) return handled(() => r.setActiveAnnotation(null));
          if (r.panel) return handled(() => r.closePanel());
          return;
        case '?':
          return handled(() => setHelp(true));
      }
      const n = Number(e.key);
      if (n >= 1 && n <= HIGHLIGHT_KEYS.length && scroller) {
        const current = readSelection(scroller);
        if (!current) return;
        handled(() => {
          void createAnnotations(docId, [
            {
              type: 'highlight',
              page: current.selection.page,
              color: HIGHLIGHT_KEYS[n - 1]!,
              anchor: {
                quote: current.selection.text,
                ...(current.rects.length ? { rects: current.rects } : {}),
              },
            },
          ]);
          window.getSelection()?.removeAllRanges();
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docId, scroller]);

  return { help, closeHelp: () => setHelp(false) };
}

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title={t.shortcuts.title}
      submitLabel={t.shortcuts.close}
      onSubmit={() => {}}
      onClose={onClose}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={keys} className="contents">
            <dt>
              <kbd className="bg-surface-muted rounded px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
