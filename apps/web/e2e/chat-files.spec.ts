import { expect, test } from '@playwright/test';
import { login, seedDocument, tinyPdf } from './helpers';

// Files in the chat (PDF, Word, text): Claude reads them, the reader never opens them,
// and they stay in the conversation.
test('attaches files for Claude to read', async ({ page }, info) => {
  await login(page);
  const docId = await seedDocument(
    page,
    `Archivos ${info.project.name}`,
    tinyPdf([['La fotosintesis ocurre en los cloroplastos.']]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('fotosintesis');
  if (info.project.name !== 'desktop') {
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  }

  const input = page.getByTestId('chat-attach-input');
  await input.setInputFiles([
    {
      name: 'ejercicios.pdf',
      mimeType: 'application/pdf',
      buffer: tinyPdf([['Ejercicio 1: calcula la energia.'], ['Ejercicio 2.']]),
    },
    {
      name: 'notas.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Notas de clase sobre la luz.'),
    },
  ]);
  const pending = page.getByTestId('pending-files');
  await expect(pending.locator('li')).toHaveCount(2);
  await expect(pending.getByRole('status')).toHaveCount(0);
  await expect(pending).toContainText('2 págs.');

  // A file Claude cannot read is refused with a reason, and can be removed.
  await input.setInputFiles({
    name: 'binario.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([0, 1, 2, 3, 0, 255]),
  });
  await expect(page.getByRole('alert')).toContainText('no puede leer ese tipo de archivo');
  await pending.getByRole('button', { name: 'Quitar binario.bin' }).click();
  await expect(pending.locator('li')).toHaveCount(2);

  const composer = page.getByRole('textbox', { name: 'Pregunta sobre el documento…' });
  await composer.fill('Resuelve el ejercicio');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Detener' })).toBeHidden();
  await expect(page.getByTestId('assistant-message').last()).toContainText(
    'He leído ejercicios.pdf y notas.md: «Ejercicio 1: calcula la energia.',
  );
  await expect(page.getByTestId('pending-files')).toHaveCount(0);
  // The reader still shows the library document, not the attached PDF.
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('fotosintesis');
  await page.screenshot({ path: info.outputPath('chat-files.png') });

  // They stay with the question after a reload, as links to the files.
  await page.reload();
  if (info.project.name !== 'desktop') {
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  }
  const kept = page.getByTestId('user-message').last().getByTestId('message-files');
  await expect(kept.getByRole('link')).toHaveCount(2);
  const pdfLink = kept.getByRole('link', { name: /ejercicios\.pdf/ });
  const res = await page.request.get((await pdfLink.getAttribute('href'))!);
  expect(res.headers()['content-type']).toBe('application/pdf');
});
