import './assets';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useEffect, useState } from 'react';
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

/** The Excalidraw board of one thread; `key` remounts it for another thread. */
function Board({ threadId }: { threadId: string }) {
  const dark = useDark();

  useEffect(() => () => detachBoardApi(), []);
  return (
    <div
      className="absolute inset-0"
      data-testid="whiteboard"
      data-thread={threadId}
      onPointerDownCapture={noteUserInput}
      onKeyDownCapture={noteUserInput}
    >
      <Excalidraw
        excalidrawAPI={(api) => setBoardApi(api)}
        initialData={{ appState: { currentItemRoughness: 1 } }}
        onChange={(elements) => noteChange(elements)}
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
  if (!loaded || !threadId) return null;
  return <Board key={threadId} threadId={threadId} />;
}
