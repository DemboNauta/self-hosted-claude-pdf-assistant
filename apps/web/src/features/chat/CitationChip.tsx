import type { Citation, LibraryTree } from '@pdfclaudeassistant/shared';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen } from 'lucide-react';
import { useNavigate } from 'react-router';
import { t } from '../../i18n';
import { libraryKey } from '../library/api';
import { useReader } from '../reader/store';

function titleOf(tree: LibraryTree | undefined, docId: string): string | null {
  for (const s of tree?.subjects ?? []) {
    for (const tp of s.topics) {
      const d = tp.documents.find((x) => x.id === docId);
      if (d) return d.title;
    }
  }
  return null;
}

/** Event the chat panel listens to (e.g. to lower the mobile sheet and show the page). */
export const CITATION_EVENT = 'pca:citation';

/**
 * Clickable citation (F-CHAT-04): jumps to the page and flashes the quote (F-VIS-03),
 * opening the other document first when it cites a different one.
 */
export function CitationChip({ citation }: { citation: Citation }) {
  const currentDoc = useReader((s) => s.docId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const same = citation.docId === currentDoc;
  const title = same ? null : titleOf(qc.getQueryData<LibraryTree>(libraryKey), citation.docId);
  const label = title ? `${title}, p. ${citation.page}` : `p. ${citation.page}`;

  const go = () => {
    window.dispatchEvent(new CustomEvent(CITATION_EVENT));
    if (same) {
      useReader.getState().goTo(citation.page, citation.quote);
      return;
    }
    const params = new URLSearchParams({ page: String(citation.page) });
    if (citation.quote) params.set('q', citation.quote);
    navigate(`/read/${citation.docId}?${params}`);
  };

  return (
    <button
      type="button"
      onClick={go}
      title={citation.quote ? `«${citation.quote}»` : t.chat.goToPage(citation.page)}
      aria-label={t.chat.citationLabel(label)}
      className="bg-surface-muted hover:bg-border mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 align-baseline text-xs font-medium whitespace-nowrap"
      data-testid="citation"
    >
      <BookOpen size={12} aria-hidden className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
