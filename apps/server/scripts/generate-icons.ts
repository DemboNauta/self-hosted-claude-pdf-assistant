/**
 * Renders the PWA icons (F-UX-05) into apps/web/public/icons.
 * Run: pnpm --filter @pdfclaudeassistant/server exec tsx scripts/generate-icons.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const out = path.resolve(import.meta.dirname, '../../web/public/icons');
const svg = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/public/favicon.svg'),
  'utf8',
);
fs.mkdirSync(out, { recursive: true });

for (const [name, size, pad] of [
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  // Maskable: the platform crops to a circle/squircle, keep the mark in the safe zone.
  ['maskable-512.png', 512, 0.1],
  ['apple-touch-icon.png', 180, 0.08],
] as const) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1f1d1a';
  ctx.fillRect(0, 0, size, size);
  const inner = Math.round(size * (1 - pad * 2));
  // Rasterise the SVG at the target size (its intrinsic size is 64 px).
  const img = await loadImage(
    Buffer.from(svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)),
  );
  ctx.drawImage(img, (size - inner) / 2, (size - inner) / 2, inner, inner);
  fs.writeFileSync(path.join(out, name), await canvas.encode('png'));
  console.log(name);
}
