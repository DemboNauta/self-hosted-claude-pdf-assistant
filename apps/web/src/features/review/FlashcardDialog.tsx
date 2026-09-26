import { Layers } from 'lucide-react';
import { useState } from 'react';
import { create } from 'zustand';
import { Dialog } from '../../components/Dialog';
import { t } from '../../i18n';
import type { SelectionAction } from '../reader/SelectionMenu';
import { createCards } from './api';

interface Draft {
  documentId: string;
  page: number;
  back: string;
}

const useDraft = create<{ draft: Draft | null; set: (d: Draft | null) => void }>((set) => ({
  draft: null,
  set: (draft) => set({ draft }),
}));

/** "Crear flashcard" in the selection menu (F-CHAT-02, F-REV-01). */
export function flashcardAction(documentId: string): SelectionAction {
  return {
    id: 'flashcard',
    label: t.chat.selection.flashcard,
    icon: Layers,
    run: (selection) =>
      useDraft.getState().set({ documentId, page: selection.page, back: selection.text }),
  };
}

function Editor({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const [front, setFront] = useState('');
  const [back, setBack] = useState(draft.back);
  return (
    <Dialog
      title={t.review.create}
      submitLabel={t.review.save}
      submitDisabled={!front.trim() || !back.trim()}
      onSubmit={() =>
        void createCards([
          {
            front: front.trim(),
            back: back.trim(),
            documentId: draft.documentId,
            page: draft.page,
          },
        ])
      }
      onClose={onClose}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t.review.front}</span>
        <textarea
          autoFocus
          value={front}
          onChange={(e) => setFront(e.target.value)}
          rows={2}
          className="border-border bg-bg w-full rounded-lg border px-3 py-2 text-base"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t.review.back}</span>
        <textarea
          value={back}
          onChange={(e) => setBack(e.target.value)}
          rows={4}
          className="border-border bg-bg w-full rounded-lg border px-3 py-2 text-base"
        />
      </label>
    </Dialog>
  );
}

export function FlashcardDialog() {
  const draft = useDraft((s) => s.draft);
  const set = useDraft((s) => s.set);
  if (!draft) return null;
  return <Editor draft={draft} onClose={() => set(null)} />;
}
