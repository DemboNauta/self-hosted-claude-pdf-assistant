import { expect, type Page } from '@playwright/test';

/**
 * Small valid PDF with one text line per entry, one page per inner array, built with
 * correct xref offsets (no PDF library needed in the browser tests).
 */
export function tinyPdf(pagesOrText: string | string[][]): Buffer {
  const pages = typeof pagesOrText === 'string' ? [[pagesOrText]] : pagesOrText;
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids: number[] = [];
  const fontId = 3;
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const lines of pages) {
    const content = lines
      .map((line, i) => `BT /F1 16 Tf 72 ${760 - i * 28} Td (${line}) Tj ET`)
      .join('\n');
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const contentId = objects.length;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Contraseña').fill('e2e-password');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();
}

/** Creates subject → topic → PDF through the API and waits until it is processed. */
export async function seedDocument(page: Page, name: string, pdf: Buffer): Promise<string> {
  const post = async <T>(url: string, data?: unknown) =>
    (await (await page.request.post(url, data === undefined ? {} : { data })).json()) as T;
  const subject = await post<{ id: string }>('/api/subjects', { name });
  const topic = await post<{ id: string }>('/api/topics', { subjectId: subject.id, name: 'Tema' });
  const up = await post<{ id: string }>('/api/uploads', {
    topicId: topic.id,
    filename: `${name}.pdf`,
    size: pdf.length,
  });
  await page.request.put(`/api/uploads/${up.id}?offset=0`, {
    headers: { 'content-type': 'application/octet-stream' },
    data: pdf,
  });
  const doc = await post<{ id: string }>(`/api/uploads/${up.id}/complete`);
  await expect
    .poll(async () => (await (await page.request.get(`/api/documents/${doc.id}`)).json()).status, {
      timeout: 30_000,
    })
    .toBe('ready');
  return doc.id;
}
