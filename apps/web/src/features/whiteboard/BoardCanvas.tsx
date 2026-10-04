import './assets';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useEffect, useLayoutEffect, useState } from 'react';
import { detachBoardApi, noteChange, noteUserInput, setBoardApi, useBoard } from './store';

/** Current app theme (the `data-theme` attribute set by `useApplyTheme`). */
function useDark() {
  const read = () => document.documentElement.dataset.theme === 'dark';
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

/** The Excalidraw board of one thread; `key` remounts it for another thread or scene. */
function Board({ threadId, revision }: { threadId: string; revision: number }) {
  const dark = useDark();

  // A layout effect: its cleanup runs before Excalidraw tears its scene down.
  useLayoutEffect(() => () => detachBoardApi(), []);
  return (
    <div
      className="absolute inset-0"
      data-testid="whiteboard"
      data-thread={threadId}
      onPointerDownCapture={noteUserInput}
      onKeyDownCapture={noteUserInput}
    >
      <Excalidraw
        excalidrawAPI={(api) => setBoardApi(api, revision)}
        initialData={{ appState: { currentItemRoughness: 1 } }}
        onChange={(elements, _appState, files) =>
          noteChange(elements, files as Record<string, unknown>)
        }
        langCode="es-ES"
        theme={dark ? 'dark' : 'light'}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: false,
            changeViewBackgroundColor: false,
          },
        }}
      />
    </div>
  );
}

/**
 * The Excalidraw canvas of the open thread's whiteboard (lazy-loaded chunk). Claude's
 * steps arrive through the store, and every change is saved a moment later.
 */
export default function BoardCanvas() {
  const threadId = useBoard((s) => s.threadId);
  const loaded = useBoard((s) => s.loaded);
  const revision = useBoard((s) => s.revision);
  if (!loaded || !threadId) return null;
  return <Board key={`${threadId}:${revision}`} threadId={threadId} revision={revision} />;
}
