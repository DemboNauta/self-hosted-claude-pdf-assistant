import type { z } from 'zod';
import { HttpError } from '../services/errors.js';

/** Parses untrusted input with Zod, throwing a 400 on failure. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const res = schema.safeParse(value);
  if (!res.success) throw new HttpError(400, 'invalid_request');
  return res.data;
}
