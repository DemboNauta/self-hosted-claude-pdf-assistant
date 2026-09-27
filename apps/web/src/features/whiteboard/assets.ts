/**
 * Excalidraw loads its fonts from this path (served by the app, see `vite.config.ts`),
 * not from its CDN. Imported before Excalidraw itself.
 */
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';
