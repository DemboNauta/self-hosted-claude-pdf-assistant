import { ApiError } from '../../lib/api';
import { t } from '../../i18n';

/** Longest side sent to the server; phone photos are much bigger. */
const MAX_SIDE = 2400;
/** Pictures up to this size go as they are (when not too big in pixels). */
const KEEP_BYTES = 2.5 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export class ImageError extends Error {}

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * A picture the student chose, pasted or photographed, as a data URL ready to send:
 * big photos are scaled down to JPEG first, so they upload fast on a phone. Formats the
 * browser cannot draw (e.g. HEIC on most browsers) are refused with a clear message.
 */
export async function prepareImage(file: Blob): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageError(t.annotations.images.errors.unsupported);
  }
  const side = Math.max(bitmap.width, bitmap.height);
  if (ACCEPTED.includes(file.type) && side <= MAX_SIDE && file.size <= KEEP_BYTES) {
    bitmap.close();
    return readAsDataUrl(file);
  }
  const scale = Math.min(1, MAX_SIDE / side);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  // JPEG has no transparency: transparent parts become white, not black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** A failed upload, in words for the student. */
export function imageErrorText(err: unknown): string {
  if (err instanceof ImageError) return err.message;
  if (err instanceof ApiError) {
    if (err.code === 'unsupported_image') return t.annotations.images.errors.unsupported;
    if (err.code === 'image_too_large' || err.status === 413)
      return t.annotations.images.errors.tooLarge;
    if (err.code === 'too_many_images') return t.annotations.images.errors.tooMany;
  }
  return t.annotations.images.errors.failed;
}

/** Image files among pasted or dropped items. */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.files].filter((f) => f.type.startsWith('image/'));
}
