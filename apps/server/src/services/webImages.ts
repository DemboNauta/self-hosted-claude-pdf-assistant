import { MAX_IMAGE_BYTES } from './images.js';

/**
 * Free pictures from the web for Claude's notes (owner's choice: Claude adds images
 * from the web). They come from Wikimedia Commons: freely licensed, with author and
 * licence to credit, and served from Wikimedia's own hosts, so the server never fetches
 * an address Claude made up.
 */
const API = 'https://commons.wikimedia.org/w/api.php';
/** Wikimedia's image hosts: originals and scaled copies. */
const ALLOWED_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const USER_AGENT = 'PdfClaudeAssistant/1.0 (self-hosted study assistant)';
/** Width of the copy kept in the note (Commons makes it on demand). */
const STORED_WIDTH = 1280;
const PREVIEW_WIDTH = 330;
const TIMEOUT_MS = 15_000;

export interface WebImage {
  title: string;
  /** Commons page of the file (shown as the source). */
  pageUrl: string;
  /** Picture to keep in the note, already scaled by Commons. */
  imageUrl: string;
  /** Small copy for Claude to choose from. */
  previewUrl: string;
  width: number;
  height: number;
  /** "Author · licence", plain text. */
  credit: string;
  description: string;
}

type Fetch = typeof fetch;

/** Where Claude's web pictures come from (tests and the e2e server inject a fake). */
export interface WebImageProvider {
  search: (query: string, limit: number) => Promise<WebImage[]>;
  download: (url: string) => Promise<Buffer>;
}

export const commonsImages: WebImageProvider = {
  search: (query, limit) => searchWebImages(query, limit),
  download: (url) => downloadWebImage(url),
};

const stripHtml = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

interface CommonsPage {
  title: string;
  imageinfo?: {
    url: string;
    thumburl?: string;
    width: number;
    height: number;
    mime: string;
    descriptionurl: string;
    extmetadata?: Record<string, { value?: string }>;
  }[];
}

/** Scaled copy of a Commons thumbnail URL (`…/330px-Name.jpg` → `…/1280px-Name.jpg`). */
const resized = (thumb: string, width: number) => thumb.replace(/\/\d+px-/, `/${width}px-`);

/** Searches Wikimedia Commons for pictures (photos, drawings, diagrams). */
export async function searchWebImages(query: string, limit: number, fetchImpl: Fetch = fetch) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6',
    gsrlimit: String(Math.min(20, limit * 2)),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(PREVIEW_WIDTH),
    iiextmetadatafilter: 'Artist|LicenseShortName|ImageDescription',
    origin: '*',
  });
  const res = await fetchImpl(`${API}?${params}`, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Wikimedia Commons answered ${res.status}`);
  const body = (await res.json()) as {
    query?: { pages?: Record<string, CommonsPage & { index?: number }> };
  };
  const pages = Object.values(body.query?.pages ?? {}).sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  const out: WebImage[] = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info?.thumburl || !info.mime.startsWith('image/')) continue;
    if (info.width < 120 || info.height < 120) continue;
    const meta = info.extmetadata ?? {};
    const artist = stripHtml(meta.Artist?.value ?? '');
    const licence = stripHtml(meta.LicenseShortName?.value ?? '');
    // Small originals have no bigger copy: keep the original, unless it is a type a note
    // does not hold (SVG, TIFF…), whose scaled copies are PNG/JPEG.
    const raster = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(info.mime);
    const imageUrl =
      info.width > STORED_WIDTH || !raster
        ? resized(
            info.thumburl,
            info.mime === 'image/svg+xml' ? STORED_WIDTH : Math.min(STORED_WIDTH, info.width),
          )
        : info.url;
    out.push({
      title: p.title.replace(/^File:/, ''),
      pageUrl: info.descriptionurl,
      imageUrl,
      previewUrl: info.thumburl,
      width: info.width,
      height: info.height,
      credit: [artist, licence].filter(Boolean).join(' · ').slice(0, 300),
      description: stripHtml(meta.ImageDescription?.value ?? '').slice(0, 200),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Downloads a picture from Wikimedia's image hosts (and nowhere else), size-capped. */
export async function downloadWebImage(url: string, fetchImpl: Fetch = fetch): Promise<Buffer> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error('Only images from Wikimedia Commons can be added.');
  }
  const res = await fetchImpl(u, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`The image could not be downloaded (${res.status}).`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error('The image is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error('The image is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
