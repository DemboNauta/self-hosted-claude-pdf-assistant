import type { Annotation } from '@pdfclaudeassistant/shared';
import { expect, test } from '@playwright/test';
import { login, seedDocument, tinyPdf } from './helpers';

// Tablet use (owner, 2026-09-28): highlighting by painting over the text, the whiteboard
// next to the PDF, and a chat whose size can be changed.

test('the highlighter turns a stroke over the text into a highlight', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'mouse strokes');
  await login(page);
  const docId = await seedDocument(
    page,
    'Subrayador',
    tinyPdf([['La mitocondria produce energia', 'mediante la respiracion celular']]),
  );
  await page.goto(`/read/${docId}`);
  const layer = page.locator('[data-page="1"] .textLayer');
  await expect(layer).toContainText('respiracion');
  await page.getByRole('button', { name: 'Herramientas de anotación' }).first().click();
  await page.getByRole('button', { name: 'Subrayar pintando sobre el texto' }).click();
  await page.getByRole('radio', { name: 'Definición' }).click();

  // From the middle of "mitocondria" to the middle of "respiracion": whole words only.
  const first = (await layer.getByText('La mitocondria produce energia').boundingBox())!;
  const second = (await layer.getByText('mediante la respiracion celular').boundingBox())!;
  await page.mouse.move(first.x + first.width * 0.2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width * 0.55, second.y + second.height / 2, {
    steps: 12,
  });
  await expect(page.getByTestId('highlighter-preview')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('highlighter.png') });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const list = (await (
        await page.request.get(`/api/documents/${docId}/annotations`)
      ).json()) as Annotation[];
      return list.map((a) => [a.type, a.color, (a.anchor as { quote?: string }).quote]);
    })
    .toEqual([['highlight', 'green', 'mitocondria produce energia mediante la respiracion']]);
  await expect(page.getByTestId('highlighter-preview')).toHaveCount(0);
});

test('the whiteboard opens next to the PDF and goes back to the chat', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'side-by-side layout');
  await login(page);
  const docId = await seedDocument(page, 'Pizarra al lado', tinyPdf('Texto de prueba'));
  await page.goto(`/read/${docId}`);
  await page.getByRole('tab', { name: 'Pizarra' }).click();
  await page.getByRole('button', { name: 'Abrir junto al PDF' }).click();

  const dock = page.getByTestId('board-dock');
  await expect(dock.getByTestId('whiteboard').locator('canvas').first()).toBeVisible();
  // The chat shows the conversation again; its board tab points to the docked board.
  await expect(page.getByRole('tab', { name: 'Conversación' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Pizarra' }).click();
  await expect(page.getByText('La pizarra está abierta junto al PDF.')).toBeVisible();

  // The grip shares the space between the board and the PDF.
  const before = (await dock.boundingBox())!.width;
  const grip = (await page.getByTestId('board-dock-handle').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x - 150, grip.y + grip.height / 2, { steps: 5 });
  await page.mouse.up();
  expect((await dock.boundingBox())!.width).toBeGreaterThan(before + 100);
  await page.screenshot({ path: info.outputPath('board-docked.png') });

  await dock.getByRole('button', { name: 'Devolver la pizarra al chat' }).click();
  await expect(dock).toHaveCount(0);
  await expect(page.getByTestId('whiteboard').locator('canvas').first()).toBeVisible();
});

test('on a tablet the chat is a side panel in landscape and a resizable sheet in portrait', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'viewport set by the test');
  await page.setViewportSize({ width: 1000, height: 700 });
  await login(page);
  const docId = await seedDocument(page, 'Tableta', tinyPdf('Texto de prueba'));
  await page.goto(`/read/${docId}`);
  await expect(page.getByRole('separator', { name: 'Cambiar ancho del chat' })).toBeVisible();
  await expect(page.getByTestId('chat-sheet')).toHaveCount(0);

  await page.setViewportSize({ width: 800, height: 1100 });
  await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  const sheet = page.getByTestId('chat-sheet');
  await expect(sheet).toBeVisible();
  const before = (await sheet.boundingBox())!.height;
  const grip = (await page.getByTestId('chat-sheet-handle').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 250, { steps: 5 });
  await page.mouse.up();
  const after = (await sheet.boundingBox())!.height;
  await page.screenshot({ path: info.outputPath('chat-sheet.png') });
  expect(after).toBeLessThan(before - 200);

  // The height is kept when the chat is opened again.
  await sheet.getByRole('button', { name: 'Cerrar chat' }).click();
  await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  expect(Math.abs((await sheet.boundingBox())!.height - after)).toBeLessThan(4);
});
