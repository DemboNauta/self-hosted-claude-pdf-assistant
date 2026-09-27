import type { ThreadSummary, Whiteboard } from '@pdfclaudeassistant/shared';
import { expect, test } from '@playwright/test';
import { login, seedDocument, tinyPdf } from './helpers';

// Visual interaction block 2: Claude explains on the whiteboard next to the chat, step by
// step, and the board keeps what was drawn.
test('Claude draws on the whiteboard and the board is kept', async ({ page }, info) => {
  await login(page);
  const docId = await seedDocument(
    page,
    `Pizarra ${info.project.name}`,
    tinyPdf([['La fotosintesis ocurre en los cloroplastos.']]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('cloroplastos');
  if (info.project.name !== 'desktop') {
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  }

  const composer = page.getByRole('textbox', { name: 'Pregunta sobre el documento…' });
  await composer.fill('Explícamelo en la pizarra');
  await composer.press('Enter');

  // The panel switches to the board while Claude draws; the answer stays readable below.
  await expect(page.getByRole('tab', { name: 'Pizarra' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('whiteboard').locator('canvas').first()).toBeVisible();
  await expect(page.getByTestId('board-answer')).toContainText('Respuesta de prueba');
  await expect(page.getByRole('button', { name: 'Detener' })).toBeHidden();

  // Both steps end up on the saved scene.
  const thread = (await (
    await page.request.get(`/api/documents/${docId}/threads/active`)
  ).json()) as ThreadSummary;
  await expect
    .poll(async () => {
      const board = (await (
        await page.request.get(`/api/threads/${thread.id}/whiteboard`)
      ).json()) as Whiteboard;
      return board.applied.length;
    })
    .toBe(2);
  const board = (await (
    await page.request.get(`/api/threads/${thread.id}/whiteboard`)
  ).json()) as Whiteboard;
  const ids = (board.scene?.elements ?? []).map((e) => (e as { id: string }).id);
  expect(ids).toEqual(expect.arrayContaining(['claude-luz', 'claude-azucar']));
  await page.screenshot({ path: info.outputPath('whiteboard.png') });

  // The chat shows where each step is explained, and a chip brings the board back.
  await page.getByRole('tab', { name: 'Conversación' }).click();
  await expect(page.getByTestId('board-chip')).toHaveCount(2);
  await page.getByTestId('board-chip').first().click();
  await expect(page.getByRole('tab', { name: 'Pizarra' })).toHaveAttribute('aria-selected', 'true');

  // After a reload the board comes back from the server.
  await page.reload();
  if (info.project.name !== 'desktop') {
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  }
  await page.getByRole('tab', { name: 'Pizarra' }).click();
  await expect(page.getByTestId('whiteboard').locator('canvas').first()).toBeVisible();
});
