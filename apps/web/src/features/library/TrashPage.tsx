import type { TrashedDocument } from '@pdfclaudeassistant/shared';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { Page } from '../../components/Page';
import { t } from '../../i18n';
import { useLibrary, usePurgeDocument, useRestoreDocument, useTrash } from './api';
import { TopicSelect } from './TopicSelect';

const dateFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long' });

/** Minimal trash (owner decision for Phase 1; full F-LIB-05 in Phase 3). */
export function TrashPage() {
  const trash = useTrash();
  const library = useLibrary();
  const restore = useRestoreDocument();
  const purge = usePurgeDocument();
  const [restoring, setRestoring] = useState<TrashedDocument | null>(null);
  const [purging, setPurging] = useState<TrashedDocument | null>(null);

  return (
    <Page title={t.library.trash.title}>
      <Link
        to="/library"
        className="text-text-muted hover:text-text -mt-4 mb-6 inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft size={16} aria-hidden />
        {t.library.title}
      </Link>
      <p className="text-text-muted mb-6 text-sm">{t.library.trash.help}</p>

      {trash.isPending && <p className="text-text-muted">{t.common.loading}</p>}
      {trash.data?.length === 0 && <p className="text-text-muted">{t.library.trash.empty}</p>}
      <ul className="divide-border divide-y">
        {trash.data?.map((doc) => (
          <li key={doc.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{doc.title}</p>
              <p className="text-text-muted text-xs">
                {t.library.trash.purgeOn(dateFmt.format(new Date(doc.purgeAt)))}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setRestoring(doc)}
              className="border-border hover:bg-surface-muted rounded-lg border px-3 py-1.5 text-sm"
            >
              {t.library.trash.restore}
            </button>
            <button
              type="button"
              onClick={() => setPurging(doc)}
              className="text-danger rounded-lg px-3 py-1.5 text-sm hover:underline"
            >
              {t.library.trash.deleteForever}
            </button>
          </li>
        ))}
      </ul>

      {restoring && library.data && (
        <RestoreDialog
          doc={restoring}
          onRestore={(topicId) => restore.mutate({ id: restoring.id, topicId })}
          onClose={() => setRestoring(null)}
          tree={library.data}
        />
      )}
      {purging && (
        <Dialog
          title={t.library.trash.deleteForever}
          submitLabel={t.library.trash.deleteForever}
          danger
          onSubmit={() => purge.mutate(purging.id)}
          onClose={() => setPurging(null)}
        >
          <p className="text-sm">{t.library.trash.confirmDeleteForever(purging.title)}</p>
        </Dialog>
      )}
    </Page>
  );
}

function RestoreDialog({
  doc,
  tree,
  onRestore,
  onClose,
}: {
  doc: TrashedDocument;
  tree: NonNullable<ReturnType<typeof useLibrary>['data']>;
  onRestore: (topicId: string) => void;
  onClose: () => void;
}) {
  // Restoring always asks for a destination (owner decision); suggest the original topic.
  const [topicId, setTopicId] = useState(doc.originalTopicId ?? '');
  const hasTopics = tree.subjects.some((s) => s.topics.length > 0);
  return (
    <Dialog
      title={`${t.library.trash.restore} «${doc.title}»`}
      submitLabel={t.library.trash.restore}
      submitDisabled={!topicId}
      onSubmit={() => onRestore(topicId)}
      onClose={onClose}
    >
      {hasTopics ? (
        <TopicSelect
          tree={tree}
          value={topicId}
          onChange={setTopicId}
          label={t.library.trash.restoreTo}
        />
      ) : (
        <p className="text-sm">{t.library.trash.noTopics}</p>
      )}
    </Dialog>
  );
}
