// Bundles the server into dist/main.js. Workspace packages (TypeScript sources) are
// inlined; every other dependency stays external and is installed in the image.
import fs from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@pdfclaudeassistant/'));

fs.rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: { main: 'src/main.ts', 'hash-password': 'scripts/hash-password.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
