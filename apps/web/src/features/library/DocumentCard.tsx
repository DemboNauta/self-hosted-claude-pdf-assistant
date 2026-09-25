import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DocumentSummary } from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { AlertCircle, FileText, GripVertical, Loader2 } from 'lucide-react';
import { Link } from 'react-router';
import { Menu, type MenuAction } from '../../components/Menu';
import { t } from '../../i18n';
import { isProcessing } from './api';
import { dndId } from './dnd';

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = (new Date(iso).getTime() - now) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'minute');
}

/** Library card: cover, title, pages, reading progress, last access (F-LIB-03). */
export function DocumentCard({ doc, actions }: { doc: DocumentSummary; actions: MenuAction[] }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: dndId('document', doc.id),
    data: { type: 'document', id: doc.id, topicId: doc.topicId ?? '' },
  });
  const ready = doc.status === 'ready';

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={clsx(
        'group border-border bg-surface relative flex flex-col overflow-hidden rounded-xl border',
        isDragging && 'opacity-40',
      )}
      data-testid="document-card"
    >
      <div className="bg-surface-muted relative aspect-[3/4] overflow-hidden">
        {doc.hasCover ? (
          <img
            src={`/api/documents/${doc.id}/cover`}
            alt=""
            loading="lazy"
            draggable={false}
            className="size-full object-cover object-top"
          />
        ) : (
          <div className="text-text-muted flex size-full items-center justify-center">
            {isProcessing(doc.status) ? (
              <Loader2 size={28} aria-hidden className="animate-spin" />
            ) : doc.status === 'error' ? (
              <AlertCircle size={28} aria-hidden />
            ) : (
              <FileText size={28} aria-hidden />
            )}
          </div>
        )}
        {ready && doc.progressPct > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/10">
            <div className="bg-text h-full" style={{ width: `${doc.progressPct}%` }} />
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-sm leading-snug font-medium">
          {ready ? (
            // The link covers the whole card; the handle and menu sit above it.
            <Link
              to={`/read/${doc.id}`}
              className="after:absolute after:inset-0 after:content-['']"
            >
              {doc.title}
            </Link>
          ) : (
            doc.title
          )}
        </h3>
        {ready ? (
          <p className="text-text-muted text-xs">
            {doc.pageCount !== null && t.library.doc.pages(doc.pageCount)}
            {doc.progressPct > 0 && ` · ${t.library.doc.read(doc.progressPct)}`}
          </p>
        ) : (
          <p
            className={clsx('text-xs', doc.status === 'error' ? 'text-danger' : 'text-text-muted')}
            role="status"
          >
            {t.library.doc.status[doc.status]}
          </p>
        )}
        <p className="text-text-muted mt-auto text-xs">
          {doc.lastOpenedAt
            ? t.library.doc.lastOpened(relativeTime(doc.lastOpenedAt))
            : t.library.doc.neverOpened}
        </p>
      </div>

      <div className="absolute top-1.5 right-1.5 left-1.5 z-10 flex justify-between">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`${t.library.dragHandle}: ${doc.title}`}
          className="bg-surface/90 text-text-muted hover:text-text cursor-grab touch-none rounded-md p-1.5 shadow-sm"
        >
          <GripVertical size={16} aria-hidden />
        </button>
        <Menu
          label={`${t.library.moreActions}: ${doc.title}`}
          actions={actions}
          className="bg-surface/90 rounded-md shadow-sm"
        />
      </div>
    </li>
  );
}
