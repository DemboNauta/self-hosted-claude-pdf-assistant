export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

type Json = Record<string, unknown> | unknown[];

/** Fetch wrapper for the backend. Cookies carry the session; errors become ApiError. */
export async function api<T>(path: string, init: RequestInit & { json?: Json } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: json ? { 'content-type': 'application/json', ...headers } : headers,
    body: json ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? 'unknown');
  }
  return (await res.json()) as T;
}
