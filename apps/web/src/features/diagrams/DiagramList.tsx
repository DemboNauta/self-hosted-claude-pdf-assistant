import type { Diagram } from '@pdfclaudeassistant/shared';
import { Trash2, Workflow } from 'lucide-react';
import { useState } from 'react';
import { t } from '../../i18n';
import { relativeTime } from '../library/DocumentCard';
import { deleteDiagram } from './api';
import { DiagramDialog } from './DiagramView';

function scopeLabel(d: Diagram) {
  if (!d.fromPage) return t.diagrams.wholeDoc;
  return d.toPage && d.toPage !== d.fromPage
    ? t.diagrams.pages(d.fromPage, d.toPage)
    : `p. ${d.fromPage}`;
}

/** Diagrams as rows: open full screen, delete. Used by the reader panel and the page. */
export function DiagramList({
  diagrams,
  showDocument,
}: {
  diagrams: Diagram[];
  showDocument?: boolean;
}) {
  const [open, setOpen] = useState<Diagram | null>(null);
  return (
    <>
      <ul className="divide-border divide-y">
        {diagrams.map((d) => (
          <li key={d.id} className="flex items-center gap-2 py-2">
            <button
              type="button"
              onClick={() => setOpen(d)}
              className="hover:bg-surface-muted flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-1.5 text-left"
            >
              <Workflow size={16} aria-hidden className="text-text-muted mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{d.title}</span>
                <span className="text-text-muted block truncate text-xs">
                  {[
                    showDocument && (d.documentTitle ?? t.diagrams.noDocument),
                    scopeLabel(d),
                    relativeTime(d.updatedAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(t.diagrams.confirmDelete(d.title))) void deleteDiagram(d.id);
              }}
              aria-label={`${t.diagrams.delete}: ${d.title}`}
              title={t.diagrams.delete}
              className="text-text-muted hover:text-danger rounded p-1.5"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {open && <DiagramDialog diagram={open} onClose={() => setOpen(null)} />}
    </>
  );
}
