import {
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

/** What is being dragged or dropped on; attached as `data` to every sortable item. */
export type DragData =
  | { type: 'subject'; id: string }
  | { type: 'topic'; id: string; subjectId: string }
  | { type: 'document'; id: string; topicId: string };

export const dndId = (type: DragData['type'], id: string) => `${type}:${id}`;

const dataOf = (c: DroppableContainer) => c.data.current as DragData | undefined;

/** Items an item can be sorted among: same type, same parent. */
function isPeer(active: DragData, other: DragData) {
  if (active.type === 'subject') return other.type === 'subject';
  if (active.type === 'topic')
    return other.type === 'topic' && other.subjectId === active.subjectId;
  return other.type === 'document' && other.topicId === active.topicId;
}

/**
 * Arrow keys move to the next peer. The stock getter considers every droppable, so in
 * the nested tree it would stop on the topics inside a subject instead of the next subject.
 */
export const libraryKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const active = args.context.active?.data.current as DragData | undefined;
  if (!active) return sortableKeyboardCoordinates(event, args);
  const all = args.context.droppableContainers;
  // The stock getter only calls getEnabled() and get() on the map.
  const droppableContainers = {
    getEnabled: () =>
      all.getEnabled().filter((c) => {
        const d = dataOf(c);
        return d !== undefined && isPeer(active, d);
      }),
    get: (id: Parameters<typeof all.get>[0]) => all.get(id),
  } as unknown as typeof all;
  return sortableKeyboardCoordinates(event, {
    ...args,
    context: { ...args.context, droppableContainers },
  });
};

/**
 * Subjects only collide with subjects and topics with topics of the same subject.
 * Documents collide with documents of their topic (reorder) or, when the pointer is
 * over the tree, with any topic (move, F-LIB-02).
 */
export const libraryCollision: CollisionDetection = (args) => {
  const active = args.active.data.current as DragData | undefined;
  if (!active) return closestCenter(args);
  const only = (pred: (d: DragData) => boolean) =>
    args.droppableContainers.filter((c) => {
      const d = dataOf(c);
      return d !== undefined && pred(d);
    });

  if (active.type !== 'document') {
    return closestCenter({ ...args, droppableContainers: only((d) => isPeer(active, d)) });
  }
  const overTopic = pointerWithin({
    ...args,
    droppableContainers: only((d) => d.type === 'topic' && d.id !== active.topicId),
  });
  if (overTopic.length) return overTopic;
  return closestCenter({ ...args, droppableContainers: only((d) => isPeer(active, d)) });
};
