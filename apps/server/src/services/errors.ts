/** Error with an HTTP status, turned into `{ error: code }` by the app error handler. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

export const notFound = () => new HttpError(404, 'not_found');
