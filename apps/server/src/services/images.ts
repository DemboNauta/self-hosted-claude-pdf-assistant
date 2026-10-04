import { createCanvas, loadImage } from '@napi-rs/canvas';
import { HttpError } from './errors.js';

/** Longest side kept for a note's picture: bigger ones are scaled down. */
export const MAX_IMAGE_SIDE = 2400;
/** Pictures up to this size are kept as they came (when not too big in pixels). */
const KEEP_BYTES = 3 * 1024 * 1024;
/** Hard limit on what is accepted, before any processing. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface StoredImage {
  data: Buffer;
  mime: string;
  width: number;
  height: number;
}

/** The real type of an image from its first bytes (never trusting the declared one). */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}

/**
 * Checks that a buffer is a picture a note can hold (PNG, JPEG, WebP or GIF, decoded to
 * be sure) and scales big ones down to WebP, so a phone photo does not take 10 MB.
 */
export async function normalizeImage(buf: Buffer): Promise<StoredImage> {
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'image_too_large');
  const mime = sniffImageType(buf);
  if (!mime) throw new HttpError(400, 'unsupported_image');
  let img: Awaited<ReturnType<typeof loadImage>>;
  try {
    img = await loadImage(buf);
  } catch {
    throw new HttpError(400, 'unsupported_image');
  }
  const { width, height } = img;
  if (!width || !height) throw new HttpError(400, 'unsupported_image');
  const side = Math.max(width, height);
  if (side <= MAX_IMAGE_SIDE && buf.length <= KEEP_BYTES) return { data: buf, mime, width, height };
  const scale = Math.min(1, MAX_IMAGE_SIDE / side);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = createCanvas(w, h);
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return { data: await canvas.encode('webp', 85), mime: 'image/webp', width: w, height: h };
}

/** A PNG/JPEG/WebP/GIF data URL → its bytes. */
export function fromDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

/** A smaller copy for Claude to choose from (search results), as PNG. */
export async function thumbnail(buf: Buffer, side: number): Promise<Buffer> {
  const img = await loadImage(buf);
  const scale = Math.min(1, side / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.encode('jpeg', 80);
}
