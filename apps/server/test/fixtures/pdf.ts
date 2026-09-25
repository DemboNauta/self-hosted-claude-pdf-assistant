import { PDFDocument, StandardFonts } from 'pdf-lib';

/** Builds a PDF whose pages contain the given lines of text (one array per page). */
export async function makePdf(
  pagesText: string[][],
  opts: { outline?: boolean } = {},
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pagesText) {
    const page = doc.addPage([595, 842]);
    lines.forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 20, size: 12, font }));
  }
  void opts;
  return Buffer.from(await doc.save());
}

/** Minimal multipart/form-data body for app.inject. */
export function multipartBody(files: { name: string; content: Buffer }[]) {
  const boundary = '----pcaTestBoundary';
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
