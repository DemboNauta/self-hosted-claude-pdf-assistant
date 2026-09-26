import type { CreateAnnotation } from '@pdfclaudeassistant/shared';
import { Check, StickyNote } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { t } from '../../i18n';
import { queryClient } from '../../lib/queryClient';
import { setPointerActions } from '../chat/ChatPanel';
import { chatSocket, useChat } from '../chat/store';
import type { SelectionAction } from '../reader/SelectionMenu';
import { useReader } from '../reader/store';
import { invalidateReview } from '../review/api';
import { annotationsKey, createAnnotations, usePalette } from './api';

/** "Subrayar" (one button per palette colour) and "Nota" in the selection menu (F-ANN-01/02). */
export function useSelectionAnnotationActions(docId: string): SelectionAction[] {
  const { palette } = usePalette();
  return [
    ...palette.map((p): SelectionAction => ({
      id: `hl-${p.key}`,
      label: `${t.annotations.highlight}: ${p.meaning}`,
      color: p.color,
      run: (selection, rects) =>
        void createAnnotations(docId, [
          {
            type: 'highlight',
            page: selection.page,
            color: p.key,
            anchor: { quote: selection.text, ...(rects.length ? { rects } : {}) },
          },
        ]),
    })),
    {
      id: 'note',
      label: t.annotations.note,
      icon: StickyNote,
      run: (selection, rects) =>
        void createAnnotations(docId, [
          {
            type: 'note',
            page: selection.page,
            color: 'yellow',
            content: '',
            anchor: { kind: 'text', quote: selection.text, ...(rects.length ? { rects } : {}) },
          },
        ]).then(([created]) => created && useReader.getState().setActiveAnnotation(created.id)),
    },
  ];
}

/** "Guardar" on Claude's marks: turns a message's pointers into annotations (F-POINT-04). */
function SavePointersButton({ messageId }: { messageId: string }) {
  const [saved, setSaved] = useState(false);
  const groups = useChat(useShallow((s) => s.pointers.filter((g) => g.messageId === messageId)));
  if (saved) {
    return (
      <span className="text-ok flex items-center gap-1">
        <Check size={12} aria-hidden />
        {t.chat.pointers.saved}
      </span>
    );
  }
  const save = async () => {
    const byDoc = new Map<string, CreateAnnotation[]>();
    for (const g of groups) {
      for (const shape of g.shapes) {
        const anchor =
          shape.anchor.kind === 'rect'
            ? {
                shape: shape.type,
                rects: [
                  { x: shape.anchor.x, y: shape.anchor.y, w: shape.anchor.w, h: shape.anchor.h },
                ],
              }
            : { shape: shape.type, quote: shape.anchor.quote };
        const list = byDoc.get(g.docId) ?? [];
        list.push({
          type: 'shape',
          page: g.page,
          color: 'claude',
          content: shape.label ?? null,
          anchor,
          author: 'claude',
        });
        byDoc.set(g.docId, list);
      }
    }
    for (const [docId, items] of byDoc) await createAnnotations(docId, items);
    setSaved(true);
    useChat.getState().clearPointers(messageId);
  };
  return (
    <button type="button" onClick={() => void save()} className="font-medium hover:underline">
      {t.chat.pointers.save}
    </button>
  );
}

let installed = false;

/** Wires annotations into the chat: save buttons and refresh after Claude's tools. */
export function installAnnotationIntegrations() {
  if (installed) return;
  installed = true;
  setPointerActions((messageId) => <SavePointersButton messageId={messageId} />);
  chatSocket.subscribe((event) => {
    if (event.type === 'data_changed' && event.scope === 'flashcards') invalidateReview();
    if (event.type === 'data_changed' && event.scope === 'memory') {
      void queryClient.invalidateQueries({ queryKey: ['memory'] });
    }
    if (event.type === 'data_changed' && event.scope === 'annotations') {
      const docId = useReader.getState().docId;
      if (docId) void queryClient.invalidateQueries({ queryKey: annotationsKey(docId) });
    }
  });
}
