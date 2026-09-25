import { rectSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import type {
  DocumentSummary,
  LibraryTree,
  SubjectNode,
  TopicNode,
} from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { ArrowLeft, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import { Dialog, NameDialog } from '../../components/Dialog';
import { t } from '../../i18n';
import { useTrashDocument, useUpdateDocument } from './api';
import { dndId } from './dnd';
import { DocumentCard } from './DocumentCard';
import { TopicSelect } from './TopicSelect';
import { UploadList } from './UploadList';
import { useUploads } from './uploads';

type DialogState =
  | { kind: 'rename'; doc: DocumentSummary }
  | { kind: 'move'; doc: DocumentSummary }
  | { kind: 'trash'; doc: DocumentSummary };

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');

/** Selected topic: PDF grid, upload button and drop zone (F-LIB-02/03, F-ING-01). */
export function TopicView({
  tree,
  subject,
  topic,
}: {
  tree: LibraryTree;
  subject: SubjectNode;
  topic: TopicNode;
}) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const addUploads = useUploads((s) => s.add);
  const updateDocument = useUpdateDocument();
  const trashDocument = useTrashDocument();
  const close = () => setDialog(null);

  const upload = (files: FileList | null) => {
    if (files?.length) addUploads([...files], topic.id);
  };

  return (
    <section
      aria-labelledby="topic-title"
      className="relative min-h-full"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        depth.current++;
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        if (--depth.current <= 0) setDragging(false);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        upload(e.dataTransfer.files);
      }}
    >
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/library"
            className="text-text-muted hover:text-text mb-2 inline-flex items-center gap-1 text-sm lg:hidden"
          >
            <ArrowLeft size={16} aria-hidden />
            {t.library.back}
          </Link>
          <p className="text-text-muted flex items-center gap-2 text-sm">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ background: subject.color }}
            />
            {subject.name}
          </p>
          <h1 id="topic-title" className="truncate font-serif text-3xl tracking-tight">
            {topic.name}
          </h1>
        </div>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="bg-accent text-accent-contrast flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
        >
          <Upload size={16} aria-hidden />
          {t.library.upload.button}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          data-testid="upload-input"
          onChange={(e) => {
            upload(e.target.files);
            e.target.value = '';
          }}
        />
      </header>

      <UploadList topicId={topic.id} />

      {topic.documents.length === 0 ? (
        <div className="border-border text-text-muted rounded-xl border border-dashed px-6 py-16 text-center">
          <p>{t.library.emptyTopic}</p>
          <p className="mt-1 text-sm">{t.library.upload.hint}</p>
        </div>
      ) : (
        <SortableContext
          items={topic.documents.map((d) => dndId('document', d.id))}
          strategy={rectSortingStrategy}
        >
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {topic.documents.map((doc) => (
              <DocumentCard
                key={doc.id}
                doc={doc}
                actions={[
                  { label: t.library.rename, onSelect: () => setDialog({ kind: 'rename', doc }) },
                  { label: t.library.doc.move, onSelect: () => setDialog({ kind: 'move', doc }) },
                  {
                    label: t.library.doc.delete,
                    danger: true,
                    onSelect: () => setDialog({ kind: 'trash', doc }),
                  },
                ]}
              />
            ))}
          </ul>
        </SortableContext>
      )}

      {dragging && (
        <div
          aria-hidden
          className={clsx(
            'border-text bg-bg/85 pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed',
          )}
        >
          <p className="font-serif text-xl">{t.library.upload.dropHere}</p>
        </div>
      )}

      {dialog?.kind === 'rename' && (
        <NameDialog
          title={t.library.rename}
          label={t.library.doc.title}
          initial={dialog.doc.title}
          submitLabel={t.library.save}
          onSubmit={(title) => updateDocument.mutate({ id: dialog.doc.id, title })}
          onClose={close}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          tree={tree}
          doc={dialog.doc}
          onMove={(topicId) => updateDocument.mutate({ id: dialog.doc.id, topicId })}
          onClose={close}
        />
      )}
      {dialog?.kind === 'trash' && (
        <Dialog
          title={t.library.doc.delete}
          submitLabel={t.library.doc.delete}
          danger
          onSubmit={() => trashDocument.mutate(dialog.doc.id)}
          onClose={close}
        >
          <p className="text-sm">«{dialog.doc.title}»</p>
        </Dialog>
      )}
    </section>
  );
}

function MoveDialog({
  tree,
  doc,
  onMove,
  onClose,
}: {
  tree: LibraryTree;
  doc: DocumentSummary;
  onMove: (topicId: string) => void;
  onClose: () => void;
}) {
  const [topicId, setTopicId] = useState('');
  return (
    <Dialog
      title={t.library.doc.move}
      submitLabel={t.library.doc.move}
      submitDisabled={!topicId}
      onSubmit={() => onMove(topicId)}
      onClose={onClose}
    >
      <TopicSelect
        tree={tree}
        value={topicId}
        onChange={setTopicId}
        label={t.library.doc.moveTo}
        exclude={doc.topicId}
      />
    </Dialog>
  );
}
