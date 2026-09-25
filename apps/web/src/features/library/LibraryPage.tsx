import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import type { LibraryTree } from '@pdfclaudeassistant/shared';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { t } from '../../i18n';
import {
  libraryKey,
  useLibrary,
  useReorderDocuments,
  useReorderSubjects,
  useReorderTopics,
  useUpdateDocument,
} from './api';
import { libraryCollision, libraryKeyboardCoordinates, type DragData } from './dnd';
import { SubjectTree } from './SubjectTree';
import { TopicView } from './TopicView';
import { setOnUploaded } from './uploads';

const LAST_TOPIC_KEY = 'pca.library.lastTopic';

function findTopic(tree: LibraryTree, topicId: string | undefined) {
  for (const subject of tree.subjects) {
    const topic = subject.topics.find((tp) => tp.id === topicId);
    if (topic) return { subject, topic };
  }
  return null;
}

/** Library: subject/topic tree on the left, PDFs of the chosen topic on the right. */
export function LibraryPage() {
  const { topicId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const library = useLibrary();
  const [dragTitle, setDragTitle] = useState<string | null>(null);

  const reorderSubjects = useReorderSubjects();
  const reorderTopics = useReorderTopics();
  const reorderDocuments = useReorderDocuments();
  const updateDocument = useUpdateDocument();

  useEffect(() => {
    setOnUploaded(() => void qc.invalidateQueries({ queryKey: libraryKey }));
  }, [qc]);

  useEffect(() => {
    if (!topicId) return;
    try {
      localStorage.setItem(LAST_TOPIC_KEY, topicId);
    } catch {
      /* storage unavailable: just don't remember */
    }
  }, [topicId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: libraryKeyboardCoordinates }),
  );

  if (library.isPending) return <p className="text-text-muted p-6">{t.common.loading}</p>;
  if (library.isError) return <p className="text-danger p-6">{t.common.error}</p>;
  const tree = library.data;
  const selected = findTopic(tree, topicId);

  // On desktop, reopen the last topic instead of an empty right pane.
  if (!topicId && window.matchMedia('(min-width: 1024px)').matches) {
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_TOPIC_KEY);
    } catch {
      /* ignore */
    }
    if (last && findTopic(tree, last)) return <Navigate to={`/library/t/${last}`} replace />;
  }
  if (topicId && !selected) {
    // A just-created topic may not be in the cached tree yet.
    if (library.isFetching) return <p className="text-text-muted p-6">{t.common.loading}</p>;
    return <Navigate to="/library" replace />;
  }

  const onDragStart = ({ active }: DragStartEvent) => {
    const data = active.data.current as DragData | undefined;
    if (data?.type !== 'document') return;
    const doc = selected?.topic.documents.find((d) => d.id === data.id);
    setDragTitle(doc?.title ?? null);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragTitle(null);
    const from = active.data.current as DragData | undefined;
    const to = over?.data.current as DragData | undefined;
    if (!from || !to || active.id === over?.id) return;

    if (from.type === 'subject' && to.type === 'subject') {
      const ids = tree.subjects.map((s) => s.id);
      reorderSubjects.mutate(arrayMove(ids, ids.indexOf(from.id), ids.indexOf(to.id)));
    } else if (from.type === 'topic' && to.type === 'topic' && from.subjectId === to.subjectId) {
      const subject = tree.subjects.find((s) => s.id === from.subjectId);
      const ids = subject?.topics.map((tp) => tp.id) ?? [];
      reorderTopics.mutate({
        subjectId: from.subjectId,
        ids: arrayMove(ids, ids.indexOf(from.id), ids.indexOf(to.id)),
      });
    } else if (from.type === 'document' && to.type === 'document' && selected) {
      const ids = selected.topic.documents.map((d) => d.id);
      reorderDocuments.mutate({
        topicId: selected.topic.id,
        ids: arrayMove(ids, ids.indexOf(from.id), ids.indexOf(to.id)),
      });
    } else if (from.type === 'document' && to.type === 'topic') {
      updateDocument.mutate({ id: from.id, topicId: to.id });
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={libraryCollision}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragTitle(null)}
    >
      <div className="flex h-full">
        <aside
          aria-label={t.library.subjects}
          className={clsx(
            'border-border w-full shrink-0 overflow-y-auto px-4 py-6 lg:block lg:w-72 lg:border-r',
            selected && 'hidden',
          )}
        >
          <h1 className="mb-6 font-serif text-3xl tracking-tight lg:hidden">{t.library.title}</h1>
          <SubjectTree
            tree={tree}
            selectedTopicId={selected?.topic.id ?? null}
            onTopicCreated={(id) => navigate(`/library/t/${id}`)}
          />
        </aside>
        <div
          className={clsx(
            'min-w-0 flex-1 overflow-y-auto px-5 py-6 lg:block lg:px-10 lg:py-10',
            !selected && 'hidden',
          )}
        >
          {selected ? (
            <TopicView tree={tree} subject={selected.subject} topic={selected.topic} />
          ) : (
            <p className="text-text-muted">{t.library.pickTopic}</p>
          )}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragTitle && (
          <div className="border-border bg-surface flex max-w-60 items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg">
            <FileText size={16} aria-hidden className="shrink-0" />
            <span className="truncate">{dragTitle}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
