import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Adds a text layer to the pages of `input` that have none, writing `output`. */
export type OcrRunner = (input: string, output: string) => Promise<void>;

/**
 * OCR for scanned PDFs (F-ING-03) through `ocrmypdf` (installed in the server image).
 * Returns null when it is not available, e.g. in local development on Windows; the
 * document is then indexed without OCR.
 */
export async function detectOcr(langs: string): Promise<OcrRunner | null> {
  try {
    await run('ocrmypdf', ['--version'], { timeout: 15_000 });
  } catch {
    return null;
  }
  return async (input, output) => {
    await run(
      'ocrmypdf',
      [
        // Only pages without text are rasterised; existing text stays untouched.
        '--skip-text',
        '-l',
        langs,
        '--output-type',
        'pdf',
        '--optimize',
        '0',
        '--jobs',
        '2',
        input,
        output,
      ],
      { timeout: 60 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
    );
  };
}
