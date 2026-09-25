/** Worker-thread entry: runs PDF extraction off the main event loop. */
import { parentPort, workerData } from 'node:worker_threads';
import { extractPdf } from './extract.js';

export interface WorkerInput {
  filePath: string;
  coverPath: string;
}

export type WorkerMessage =
  | { type: 'pages'; pages: import('./extract.js').ExtractedPage[] }
  | { type: 'done'; result: import('./extract.js').ExtractResult }
  | { type: 'error'; message: string };

const { filePath, coverPath } = workerData as WorkerInput;
const post = (m: WorkerMessage) => parentPort!.postMessage(m);

extractPdf(filePath, coverPath, (pages) => post({ type: 'pages', pages }))
  .then((result) => post({ type: 'done', result }))
  .catch((err: unknown) =>
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
  );
