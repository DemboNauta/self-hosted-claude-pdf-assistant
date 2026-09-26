import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import type { LookupFunction } from 'node:net';
import { HttpError } from './errors.js';

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60_000;
/** Cap when MAX_UPLOAD_MB is 0 (unlimited uploads): a URL is not a trusted source. */
export const DEFAULT_URL_LIMIT = 1024 * 1024 * 1024;

/** True for loopback, private, link-local, CGNAT, multicast and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb') ||
    v6.startsWith('ff')
  );
}

/**
 * DNS lookup that refuses non-public addresses. It is used for the actual connection,
 * so a rebinding DNS answer cannot slip a private address in after a check.
 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as unknown as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return callback(new HttpError(400, 'url_not_allowed'), '', 4);
    if ((options as { all?: boolean }).all)
      return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

function get(url: URL, allowPrivate: boolean): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (
      !allowPrivate &&
      net.isIP(url.hostname.replace(/^\[|\]$/g, '')) &&
      isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))
    ) {
      reject(new HttpError(400, 'url_not_allowed'));
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      {
        ...(allowPrivate ? {} : { lookup: safeLookup }),
        timeout: TIMEOUT_MS,
        headers: {
          'user-agent': 'PdfClaudeAssistant/1.0 (+self-hosted study app)',
          accept: 'application/pdf,*/*;q=0.5',
        },
      },
      resolve,
    );
    req.on('timeout', () => req.destroy(new HttpError(504, 'url_timeout')));
    req.on('error', reject);
  });
}

/** File name suggested by the response or the URL path. */
function filenameOf(res: http.IncomingMessage, url: URL): string {
  const cd = res.headers['content-disposition'] ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  const raw = star
    ? decodeURIComponent(star[1]!)
    : (plain?.[1] ?? decodeURIComponent(path.basename(url.pathname)));
  return raw || 'documento.pdf';
}

/**
 * Downloads a PDF from a public URL to `dest` (F-ING-02, SPEC §12): http(s) only,
 * no private or local addresses (checked on every redirect and at connect time),
 * size limit, and PDF content checked by the caller.
 */
export async function downloadPdf(
  rawUrl: string,
  dest: string,
  maxBytes: number,
  /** Tests only: lets a local test server be the source. */
  { allowPrivate = false }: { allowPrivate?: boolean } = {},
): Promise<{ filename: string; size: number }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'invalid_url');
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new HttpError(400, 'invalid_url');
    if (url.username || url.password) throw new HttpError(400, 'invalid_url');
    const res = await get(url, allowPrivate);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url);
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new HttpError(502, 'url_fetch_failed');
    }
    const type = String(res.headers['content-type'] ?? '').toLowerCase();
    if (
      type &&
      !type.includes('pdf') &&
      !type.includes('octet-stream') &&
      !type.includes('binary')
    ) {
      res.resume();
      throw new HttpError(415, 'not_a_pdf');
    }
    const declared = Number(res.headers['content-length'] ?? 0);
    if (declared > maxBytes) {
      res.resume();
      throw new HttpError(413, 'file_too_large');
    }
    let size = 0;
    const out = fs.createWriteStream(dest);
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > maxBytes) throw new HttpError(413, 'file_too_large');
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise<void>((resolve, reject) =>
        out.end((e?: Error | null) => (e ? reject(e) : resolve())),
      );
    } catch (err) {
      out.destroy();
      res.destroy();
      await fs.promises.rm(dest, { force: true });
      throw err;
    }
    return { filename: filenameOf(res, url), size };
  }
  throw new HttpError(502, 'too_many_redirects');
}
