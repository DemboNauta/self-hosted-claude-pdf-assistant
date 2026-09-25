import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { LibraryTree, SubjectNode, TopicNode } from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { ChevronRight, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Dialog, NameDialog } from '../../components/Dialog';
import { Menu } from '../../components/Menu';
import { t } from '../../i18n';
import {
  useCreateSubject,
  useCreateTopic,
  useDeleteSubject,
  useDeleteTopic,
  useUpdateSubject,
  useUpdateTopic,
} from './api';
import { dndId, type DragData } from './dnd';

type DialogState =
  | { kind: 'newSubject' }
  | { kind: 'renameSubject'; subject: SubjectNode }
  | { kind: 'deleteSubject'; subject: SubjectNode }
  | { kind: 'newTopic'; subject: SubjectNode }
  | { kind: 'renameTopic'; topic: TopicNode }
  | { kind: 'deleteTopic'; topic: TopicNode };

const countDocs = (s: SubjectNode) => s.topics.reduce((n, tp) => n + tp.documents.length, 0);

/** Subject → topic tree with create/rename/delete and drag & drop reordering (F-LIB-01). */
export function SubjectTree({
  tree,
  selectedTopicId,
  onTopicCreated,
}: {
  tree: LibraryTree;
  selectedTopicId: string | null;
  onTopicCreated: (topicId: string) => void;
}) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const close = () => setDialog(null);

  const createSubject = useCreateSubject();
  const updateSubject = useUpdateSubject();
  const deleteSubject = useDeleteSubject();
  const createTopic = useCreateTopic();
  const updateTopic = useUpdateTopic();
  const deleteTopic = useDeleteTopic();

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-text-muted text-xs font-medium tracking-wide uppercase">
          {t.library.subjects}
        </h2>
        <button
          type="button"
          onClick={() => setDialog({ kind: 'newSubject' })}
          className="text-text-muted hover:text-text hover:bg-surface-muted flex items-center gap-1 rounded-md px-2 py-1 text-sm"
        >
          <Plus size={16} aria-hidden />
          {t.library.newSubject}
        </button>
      </div>

      {tree.subjects.length === 0 && (
        <p className="text-text-muted text-sm">{t.library.emptyLibrary}</p>
      )}

      <SortableContext
        items={tree.subjects.map((s) => dndId('subject', s.id))}
        strategy={verticalListSortingStrategy}
      >
        <ul className="space-y-1" aria-label={t.library.subjects}>
          {tree.subjects.map((subject) => {
            const open = !collapsed.has(subject.id);
            return (
              <SortableRow
                key={subject.id}
                id={dndId('subject', subject.id)}
                data={{ type: 'subject', id: subject.id }}
              >
                {(handle) => (
                  <>
                    <div className="group hover:bg-surface-muted flex items-center gap-1 rounded-md pr-1">
                      {handle}
                      <button
                        type="button"
                        onClick={() => toggle(subject.id)}
                        aria-expanded={open}
                        aria-label={open ? t.library.collapse : t.library.expand}
                        className="text-text-muted rounded p-1"
                      >
                        <ChevronRight
                          size={16}
                          aria-hidden
                          className={clsx('transition-transform', open && 'rotate-90')}
                        />
                      </button>
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: subject.color }}
                      />
                      <span className="min-w-0 flex-1 truncate py-2 pl-1.5 text-sm font-medium">
                        {subject.name}
                      </span>
                      <Menu
                        label={`${t.library.moreActions}: ${subject.name}`}
                        actions={[
                          {
                            label: t.library.newTopic,
                            onSelect: () => setDialog({ kind: 'newTopic', subject }),
                          },
                          {
                            label: t.library.rename,
                            onSelect: () => setDialog({ kind: 'renameSubject', subject }),
                          },
                          {
                            label: t.library.delete,
                            danger: true,
                            onSelect: () => setDialog({ kind: 'deleteSubject', subject }),
                          },
                        ]}
                      />
                    </div>
                    {open && (
                      <TopicList
                        subject={subject}
                        selectedTopicId={selectedTopicId}
                        onNewTopic={() => setDialog({ kind: 'newTopic', subject })}
                        onRename={(topic) => setDialog({ kind: 'renameTopic', topic })}
                        onDelete={(topic) => setDialog({ kind: 'deleteTopic', topic })}
                      />
                    )}
                  </>
                )}
              </SortableRow>
            );
          })}
        </ul>
      </SortableContext>

      <Link
        to="/library/trash"
        className="text-text-muted hover:text-text flex items-center gap-2 rounded-md px-2 py-2 text-sm"
      >
        <Trash2 size={16} aria-hidden />
        {t.library.trash.open}
      </Link>

      {dialog?.kind === 'newSubject' && (
        <NameDialog
          title={t.library.newSubject}
          label={t.library.subjectName}
          submitLabel={t.library.create}
          onSubmit={(name) => createSubject.mutate({ name })}
          onClose={close}
        />
      )}
      {dialog?.kind === 'renameSubject' && (
        <NameDialog
          title={t.library.rename}
          label={t.library.subjectName}
          initial={dialog.subject.name}
          submitLabel={t.library.save}
          onSubmit={(name) => updateSubject.mutate({ id: dialog.subject.id, name })}
          onClose={close}
        />
      )}
      {dialog?.kind === 'deleteSubject' && (
        <Dialog
          title={t.library.delete}
          submitLabel={t.library.delete}
          danger
          onSubmit={() => deleteSubject.mutate(dialog.subject.id)}
          onClose={close}
        >
          <p className="text-sm">
            {t.library.confirmDeleteSubject(dialog.subject.name, countDocs(dialog.subject))}
          </p>
        </Dialog>
      )}
      {dialog?.kind === 'newTopic' && (
        <NameDialog
          title={`${t.library.newTopic} · ${dialog.subject.name}`}
          label={t.library.topicName}
          submitLabel={t.library.create}
          onSubmit={(name) =>
            createTopic.mutate(
              { subjectId: dialog.subject.id, name },
              { onSuccess: (topic) => onTopicCreated(topic.id) },
            )
          }
          onClose={close}
        />
      )}
      {dialog?.kind === 'renameTopic' && (
        <NameDialog
          title={t.library.rename}
          label={t.library.topicName}
          initial={dialog.topic.name}
          submitLabel={t.library.save}
          onSubmit={(name) => updateTopic.mutate({ id: dialog.topic.id, name })}
          onClose={close}
        />
      )}
      {dialog?.kind === 'deleteTopic' && (
        <Dialog
          title={t.library.delete}
          submitLabel={t.library.delete}
          danger
          onSubmit={() => deleteTopic.mutate(dialog.topic.id)}
          onClose={close}
        >
          <p className="text-sm">
            {t.library.confirmDeleteTopic(dialog.topic.name, dialog.topic.documents.length)}
          </p>
        </Dialog>
      )}
    </div>
  );
}

function TopicList({
  subject,
  selectedTopicId,
  onNewTopic,
  onRename,
  onDelete,
}: {
  subject: SubjectNode;
  selectedTopicId: string | null;
  onNewTopic: () => void;
  onRename: (topic: TopicNode) => void;
  onDelete: (topic: TopicNode) => void;
}) {
  return (
    <div className="ml-6">
      <SortableContext
        items={subject.topics.map((tp) => dndId('topic', tp.id))}
        strategy={verticalListSortingStrategy}
      >
        <ul className="space-y-0.5">
          {subject.topics.map((topic) => (
            <SortableRow
              key={topic.id}
              id={dndId('topic', topic.id)}
              data={{ type: 'topic', id: topic.id, subjectId: subject.id }}
            >
              {(handle, { isDocOver }) => (
                <div
                  className={clsx(
                    'flex items-center gap-1 rounded-md pr-1',
                    topic.id === selectedTopicId ? 'bg-surface-muted' : 'hover:bg-surface-muted',
                    isDocOver && 'ring-text ring-2',
                  )}
                >
                  {handle}
                  <Link
                    to={`/library/t/${topic.id}`}
                    aria-current={topic.id === selectedTopicId ? 'page' : undefined}
                    className={clsx(
                      'min-w-0 flex-1 truncate py-2 text-sm',
                      topic.id === selectedTopicId ? 'font-medium' : 'text-text-muted',
                    )}
                  >
                    {topic.name}
                  </Link>
                  <span className="text-text-muted text-xs tabular-nums">
                    {topic.documents.length || ''}
                  </span>
                  <Menu
                    label={`${t.library.moreActions}: ${topic.name}`}
                    actions={[
                      { label: t.library.rename, onSelect: () => onRename(topic) },
                      { label: t.library.delete, danger: true, onSelect: () => onDelete(topic) },
                    ]}
                  />
                </div>
              )}
            </SortableRow>
          ))}
        </ul>
      </SortableContext>
      {subject.topics.length === 0 && (
        <p className="text-text-muted px-2 py-1 text-sm">{t.library.emptySubject}</p>
      )}
      <button
        type="button"
        onClick={onNewTopic}
        className="text-text-muted hover:text-text flex items-center gap-1 rounded-md px-2 py-1.5 text-sm"
      >
        <Plus size={14} aria-hidden />
        {t.library.newTopic}
      </button>
    </div>
  );
}

/** Sortable <li> that hands its children a drag handle (keeps clicks and scrolling free). */
function SortableRow({
  id,
  data,
  children,
}: {
  id: string;
  data: DragData;
  children: (handle: ReactNode, state: { isDocOver: boolean }) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
    active,
  } = useSortable({ id, data });
  const isDocOver = isOver && (active?.data.current as DragData | undefined)?.type === 'document';
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={t.library.dragHandle}
      className="text-text-muted/60 hover:text-text cursor-grab touch-none rounded p-1"
    >
      <GripVertical size={14} aria-hidden />
    </button>
  );
  return (
    <li
      ref={setNodeRef}
      style={{
        // Topics under a dragged document must not shift: only sortable peers move.
        transform: isDocOver ? undefined : CSS.Translate.toString(transform),
        transition,
      }}
      className={clsx(isDragging && 'relative z-10 opacity-60')}
    >
      {children(handle, { isDocOver })}
    </li>
  );
}
