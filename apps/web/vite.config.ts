import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const api = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

/**
 * Serves Excalidraw's fonts from the app itself (`/excalidraw/fonts/…`) instead of its
 * default CDN: the app is self-hosted. Xiaolai (13 MB of CJK glyphs) is left out.
 */
function excalidrawFonts(): Plugin {
  const src = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    'node_modules/@excalidraw/excalidraw/dist/prod/fonts',
  );
  const skip = new Set(['Xiaolai']);
  // The Latin subset of Excalifont, also served under a stable name: the board loads it
  // before measuring text (keep in sync with apps/server/assets/fonts).
  const latin = 'Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2';
  const stable = 'Excalifont-Latin.woff2';
  const files = () =>
    fs
      .readdirSync(src)
      .filter((family) => !skip.has(family))
      .flatMap((family) => fs.readdirSync(path.join(src, family)).map((f) => path.join(family, f)));
  return {
    name: 'excalidraw-fonts',
    configureServer(server) {
      server.middlewares.use('/excalidraw/fonts', (req, res, next) => {
        const asked = decodeURIComponent((req.url ?? '').split('?')[0]!).replace(/^\/+/, '');
        const rel = asked === stable ? latin : asked;
        const file = path.join(src, rel);
        if (!file.startsWith(src) || rel.startsWith('Xiaolai') || !fs.existsSync(file)) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'font/woff2');
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: `excalidraw/fonts/${stable}`,
        source: fs.readFileSync(path.join(src, latin)),
      });
      for (const rel of files()) {
        this.emitFile({
          type: 'asset',
          fileName: `excalidraw/fonts/${rel.replaceAll('\\', '/')}`,
          source: fs.readFileSync(path.join(src, rel)),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), excalidrawFonts()],
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
});
