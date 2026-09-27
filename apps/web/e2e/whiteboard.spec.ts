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
  // A box with a heading and a body: wrapped with the board's font (Excalifont), so the
  // lines fit inside the box.
  const body = (board.scene?.elements ?? []).find(
    (e) => (e as { containerId?: string }).containerId === 'claude-nota',
  ) as { text: string } | undefined;
  expect(body?.text).toContain('Idea clave\nLa planta convierte la energía de la\nluz');
  await page.screenshot({ path: info.outputPath('whiteboard.png') });

  // The chat shows where each step is explained, and a chip brings the board back.
  await page.getByRole('tab', { name: 'Conversación' }).click();
  await expect(page.getByTestId('board-chip')).toHaveCount(2);
  await page.getByTestId('board-chip').first().click();
  await expect(page.getByRole('tab', { name: 'Pizarra' })).toHaveAttribute('aria-selected', 'true');

  // Switching to the conversation and back keeps the drawing (it used to be wiped).
  await page.getByRole('tab', { name: 'Conversación' }).click();
  await page.getByRole('tab', { name: 'Pizarra' }).click();
  await expect(page.getByTestId('whiteboard').locator('canvas').first()).toBeVisible();
  await page.waitForTimeout(2500);
  const kept = (await (
    await page.request.get(`/api/threads/${thread.id}/whiteboard`)
  ).json()) as Whiteboard;
  expect((kept.scene?.elements ?? []).map((e) => (e as { id: string }).id)).toEqual(
    expect.arrayContaining(['claude-luz', 'claude-azucar', 'claude-nota']),
  );

  // After a reload the board comes back from the server.
  await page.reload();
  if (info.project.name !== 'desktop') {
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  }
  await page.getByRole('tab', { name: 'Pizarra' }).click();
  await expect(page.getByTestId('whiteboard').locator('canvas').first()).toBeVisible();
});

// Block 3: the student draws on the board and Claude looks at it and corrects it there.
test('the student draws and Claude reviews the board', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'drawing with the mouse');
  await login(page);
  const docId = await seedDocument(
    page,
    `Pizarra alumno ${info.project.name}`,
    tinyPdf([['La fotosintesis ocurre en los cloroplastos.']]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('cloroplastos');
  await page.getByRole('tab', { name: 'Pizarra' }).click();
  const canvas = page.getByTestId('whiteboard').locator('canvas.interactive');
  await expect(canvas).toBeVisible();

  // A rectangle drawn by hand (the "r" tool, then a drag).
  await canvas.click({ position: { x: 20, y: 200 } });
  await page.keyboard.press('r');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 200, { steps: 8 });
  await page.mouse.up();

  const thread = (await (
    await page.request.get(`/api/documents/${docId}/threads/active`)
  ).json()) as ThreadSummary;
  const board = async () =>
    (await (await page.request.get(`/api/threads/${thread.id}/whiteboard`)).json()) as Whiteboard;
  await expect.poll(async () => (await board()).scene?.elements.length ?? 0).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Revisar mi pizarra' }).click();
  await expect(page.getByTestId('board-answer')).toContainText('He mirado tu pizarra');
  await expect(page.getByRole('button', { name: 'Detener' })).toBeHidden();
  await expect.poll(async () => (await board()).applied.length).toBe(1);
});
