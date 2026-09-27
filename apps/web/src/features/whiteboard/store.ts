import {
  boardStepKey,
  type BoardScene,
  type BoardStep,
  type Whiteboard,
} from '@pdfclaudeassistant/shared';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { create } from 'zustand';
import { api as http } from '../../lib/api';
import { chatSocket, setBoardRevealer, useChat } from '../chat/store';
import { bottomOf, stepSkeletons, type Box } from './convert';

/** Excalidraw is heavy: loaded only once the board is used. */
const excalidraw = () => import('@excalidraw/excalidraw');

type SceneElement = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  isDeleted?: boolean;
  containerId?: string | null;
};

interface BoardState {
  /** What the chat panel shows: the conversation or the whiteboard. */
  view: 'chat' | 'board';
  /** Board shown full screen. */
  expanded: boolean;
  threadId: string | null;
  steps: BoardStep[];
  applied: string[];
  scene: BoardScene | null;
  loaded: boolean;
  /** Scene ids of the elements each step drew (this session), to scroll to them. */
  stepElements: Record<string, string[]>;
  setView: (view: 'chat' | 'board') => void;
  setExpanded: (expanded: boolean) => void;
}

export const useBoard = create<BoardState>((set) => ({
  view: 'chat',
  expanded: false,
  threadId: null,
  steps: [],
  applied: [],
  scene: null,
  loaded: false,
  stepElements: {},
  setView: (view) => set({ view }),
  setExpanded: (expanded) => set({ expanded }),
}));

let excalidrawApi: ExcalidrawImperativeAPI | null = null;
/**
 * The board instance that has taken over the store's scene: from then on it holds the
 * truth. Before that (and while unmounted) the store's scene does.
 */
let readyApi: ExcalidrawImperativeAPI | null = null;

/** The mounted board registers itself; while it is not mounted the store keeps the scene. */
export function setBoardApi(api: ExcalidrawImperativeAPI | null) {
  // Excalidraw may hand the same API again on re-render.
  if (api === excalidrawApi) return;
  excalidrawApi = api;
  if (api) void attach(api);
}

/**
 * A board was mounted: once the steps being drawn are done and Excalidraw has finished
 * initialising, it gets the store's scene and takes over.
 */
async function attach(api: ExcalidrawImperativeAPI) {
  await queue;
  for (let i = 0; i < 100 && api.getAppState().isLoading; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (excalidrawApi !== api) return;
  const scene = useBoard.getState().scene;
  if (scene) {
    api.addFiles(Object.values(scene.files) as never);
    api.updateScene({ elements: scene.elements as never });
  }
  readyApi = api;
  if (pendingFocus) focusElements(pendingFocus);
  else if (scene?.elements.length) {
    // The whole drawing in view, never zoomed in past 100 %.
    api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1 });
  }
  pendingFocus = null;
}

/** The board unmounts: keep its scene in the store and save it. */
export function detachBoardApi() {
  if (!excalidrawApi) return;
  const elements = currentElements();
  const files = currentFiles();
  excalidrawApi = null;
  readyApi = null;
  useBoard.setState({ scene: { elements, files } });
  clearTimeout(saveTimer);
  void save();
}

const live = () => (excalidrawApi && readyApi === excalidrawApi ? excalidrawApi : null);

const currentElements = (): SceneElement[] =>
  (live()
    ? (excalidrawApi!.getSceneElementsIncludingDeleted() as unknown as SceneElement[])
    : ((useBoard.getState().scene?.elements ?? []) as SceneElement[])
  ).filter((e) => !e.isDeleted);

const currentFiles = (): Record<string, unknown> =>
  live()
    ? (excalidrawApi!.getFiles() as Record<string, unknown>)
    : (useBoard.getState().scene?.files ?? {});

// ---- saving ----

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lastSaved = '';

/** Saves the scene a moment after the last change (Claude's steps or the student's strokes). */
export function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 1200);
}

async function save() {
  const { threadId, applied } = useBoard.getState();
  if (!threadId) return;
  const elements = currentElements();
  const files = currentFiles();
  // Only the files still used by an image on the board.
  const used = new Set(elements.map((e) => (e as { fileId?: string }).fileId).filter(Boolean));
  const scene: BoardScene = {
    elements,
    files: Object.fromEntries(Object.entries(files).filter(([id]) => used.has(id))),
  };
  const signature = `${elements.reduce((n, e) => n + e.version, 0)}:${elements.length}:${applied.length}`;
  if (signature === lastSaved) return;
  useBoard.setState({ scene });
  await http(`/threads/${threadId}/whiteboard`, { method: 'PUT', json: { scene, applied } });
  if (useBoard.getState().threadId === threadId) lastSaved = signature;
}

// ---- applying Claude's steps ----

let queue: Promise<void> = Promise.resolve();
/** Step keys waiting in the queue, so a step is never queued twice. */
const queued = new Set<string>();

/** Draws steps on the board in order (each one once). */
function enqueue(steps: BoardStep[], opts: { focus: boolean }) {
  for (const step of steps) {
    const key = boardStepKey(step);
    if (queued.has(key)) continue;
    queued.add(key);
    queue = queue
      .then(() => apply(step, opts))
      .catch((err) => console.error(err))
      .finally(() => queued.delete(key));
  }
  return queue;
}

async function apply(step: BoardStep, { focus }: { focus: boolean }) {
  const key = boardStepKey(step);
  const state = useBoard.getState();
  if (state.applied.includes(key)) return;
  const threadId = state.threadId;
  const ex = await excalidraw();
  if (useBoard.getState().threadId !== threadId) return;

  let elements = step.clear ? [] : currentElements();
  const boxes = new Map<string, Box>(elements.map((e) => [e.id, e]));
  const skeletons = stepSkeletons(step, boxes);
  const drawn = ex.convertToExcalidrawElements(skeletons as never, {
    regenerateIds: false,
  }) as unknown as SceneElement[];

  let extra: SceneElement[] = [];
  const files: Record<string, unknown> = {};
  if (step.mermaid) {
    try {
      const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
      const parsed = await parseMermaidToExcalidraw(step.mermaid);
      const converted = ex.convertToExcalidrawElements(
        parsed.elements as never,
      ) as unknown as SceneElement[];
      // Below everything else, from the left edge.
      const top = bottomOf([...elements, ...drawn]) + (elements.length || drawn.length ? 60 : 0);
      const minX = Math.min(...converted.map((e) => e.x));
      const minY = Math.min(...converted.map((e) => e.y));
      extra = converted.map((e) => ({ ...e, x: e.x - minX + 40, y: e.y - minY + top }));
      Object.assign(files, parsed.files ?? {});
    } catch (err) {
      console.warn('[whiteboard] Mermaid diagram could not be drawn', err);
    }
  }

  // Drawing an id again replaces that element (and the label inside it).
  const replaced = new Set(drawn.map((e) => e.id));
  elements = elements.filter((e) => !replaced.has(e.id) && !replaced.has(e.containerId ?? ''));
  const next = [...elements, ...drawn, ...extra];

  const added = Object.entries(step.files ?? {}).map(([id, dataURL]) => ({
    id,
    dataURL,
    mimeType: 'image/png',
    created: Date.now(),
  }));
  for (const f of added) files[f.id] = f;

  if (excalidrawApi) {
    if (Object.keys(files).length) excalidrawApi.addFiles(Object.values(files) as never);
    excalidrawApi.updateScene({ elements: next as never });
    // Keep the whole drawing in view as it grows, never zooming in past 100 %.
    if (focus && live() && drawn.length + extra.length) {
      excalidrawApi.scrollToContent(next as never, {
        fitToViewport: true,
        viewportZoomFactor: 0.9,
        maxZoom: 1,
        animate: true,
      });
    }
  }
  useBoard.setState((s) => ({
    scene: { elements: next, files: { ...(s.scene?.files ?? {}), ...files } },
    applied: [...s.applied, key],
    stepElements: { ...s.stepElements, [key]: [...drawn, ...extra].map((e) => e.id) },
  }));
  scheduleSave();
}

/**
 * Draws the steps of an answer as the explanation reaches them (`ids`), or with `ids`
 * null the ones it never referenced (`exclude`) when it ends.
 */
function reveal(messageId: string, ids: string[] | null, exclude?: Set<string>) {
  const steps = useBoard
    .getState()
    .steps.filter(
      (s) => s.messageId === messageId && (ids ? ids.includes(s.id) : !exclude?.has(s.id)),
    );
  const { applied } = useBoard.getState();
  const fresh = steps.filter((s) => {
    const key = boardStepKey(s);
    return !applied.includes(key) && !queued.has(key);
  });
  if (!fresh.length) return;
  useBoard.setState({ view: 'board' });
  void enqueue(fresh, { focus: true });
}
setBoardRevealer(reveal);

/** Shows the board and what a step drew ("[[mark:w1]]" chip). */
export function showStep(messageId: string, stepId: string) {
  useBoard.setState({ view: 'board' });
  const ids = useBoard.getState().stepElements[`${messageId}:${stepId}`];
  if (!ids?.length) return;
  if (live()) focusElements(ids);
  // The board is being mounted: focus once it has loaded.
  else pendingFocus = ids;
}

let pendingFocus: string[] | null = null;

/** Scrolls to some elements and selects them, so the student sees what a step drew. */
function focusElements(ids: string[]) {
  const api = live();
  if (!api) return;
  const els = api.getSceneElements().filter((e) => ids.includes(e.id));
  if (!els.length) return;
  api.updateScene({
    appState: { selectedElementIds: Object.fromEntries(els.map((e) => [e.id, true])) } as never,
  });
  api.scrollToContent(els, {
    fitToViewport: true,
    viewportZoomFactor: 0.8,
    maxZoom: 1.5,
    animate: true,
  });
}

// ---- loading ----

async function load(threadId: string | null) {
  clearTimeout(saveTimer);
  lastSaved = '';
  useBoard.setState({
    threadId,
    steps: [],
    applied: [],
    scene: null,
    loaded: false,
    stepElements: {},
    expanded: false,
  });
  if (!threadId) return;
  const board = await http<Whiteboard>(`/threads/${threadId}/whiteboard`);
  if (useBoard.getState().threadId !== threadId) return;
  useBoard.setState({
    steps: board.steps,
    applied: board.applied,
    scene: board.scene,
    loaded: true,
  });
  // Steps drawn while the board was not open (another device, a reload mid-answer).
  const running = useChat.getState().running;
  const pending = board.steps.filter(
    (s) =>
      !board.applied.includes(boardStepKey(s)) &&
      !(running && s.messageId === useChat.getState().messages.at(-1)?.id),
  );
  if (pending.length) void enqueue(pending, { focus: false });
}

useChat.subscribe((s, prev) => {
  if (s.threadId !== prev.threadId) void load(s.threadId);
});

chatSocket.subscribe((event) => {
  if (event.type !== 'board_step' || event.threadId !== useBoard.getState().threadId) return;
  useBoard.setState((s) => ({ steps: [...s.steps, event.step] }));
});

// A thread may already be open when the board module loads.
void load(useChat.getState().threadId);
