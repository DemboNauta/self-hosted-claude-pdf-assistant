import type { Annotation, ThreadSummary, Whiteboard } from '@pdfclaudeassistant/shared';
import { expect, test } from '@playwright/test';
import { login, seedDocument, selectInPdf, tinyPdf } from './helpers';

/** A small pink PNG, as if picked from the phone's gallery. */
const PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAYAAABr5z2BAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAbSURBVCiRY7xmnPOfgQLARInmUQNGDRg8BgAAmvkCjC7fGvoAAAAASUVORK5CYII=',
  'base64',
);

// Pictures in notes: the student adds their own, and Claude adds one from the web.
test('pictures in notes, from the student and from Claude', async ({ page }, info) => {
  await login(page);
  const docId = await seedDocument(
    page,
    `Imágenes ${info.project.name}`,
    tinyPdf([['La fotosintesis ocurre en los cloroplastos.', 'El ciclo de Calvin fija el CO2.']]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Calvin');
  const menu = page.getByRole('toolbar', { name: 'Acciones sobre la selección' });

  // A note on a selection, with a picture chosen from a file (or the camera on a phone).
  await selectInPdf(page, 'La fotosintesis ocurre');
  await menu.getByRole('button', { name: 'Nota' }).click();
  const popover = page.getByTestId('annotation-popover');
  await expect(popover).toBeVisible();
  await popover
    .getByTestId('note-image-input')
    .setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: PHOTO });
  await expect(popover.getByTestId('note-image')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('note-image.png') });

  // It opens full size, with a caption that is saved.
  await popover.getByTestId('note-image').click();
  const viewer = page.getByTestId('media-viewer');
  await expect(viewer.locator('img')).toBeVisible();
  await viewer.getByRole('textbox', { name: 'Pie de imagen' }).fill('Mi esquema');
  await viewer.getByRole('textbox', { name: 'Pie de imagen' }).press('Enter');
  await viewer.getByRole('button', { name: 'Cerrar' }).click();
  await expect(viewer).toHaveCount(0);
  const notes = async () =>
    (await (await page.request.get(`/api/documents/${docId}/annotations`)).json()) as Annotation[];
  await expect.poll(async () => (await notes())[0]?.images[0]?.caption).toBe('Mi esquema');
  await popover.getByRole('button', { name: 'Cerrar panel' }).click();

  // The note's marker can be dragged off the text it covers; the note keeps its passage.
  if (info.project.name === 'desktop') {
    const marker = page.locator('[data-page="1"]').getByRole('button', { name: 'Abrir nota' });
    const box = (await marker.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 80, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => (await notes())[0]?.anchor)
      .toMatchObject({ kind: 'text', quote: 'La fotosintesis ocurre', pin: {} });
    const moved = (await marker.boundingBox())!;
    expect(moved.y).toBeGreaterThan(box.y + 40);
    await page.screenshot({ path: info.outputPath('moved-marker.png') });
  }

  // Claude proposes a margin note with a free picture from the web, credited.
  if (info.project.name !== 'desktop') {
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  }
  await selectInPdf(page, 'El ciclo de Calvin fija');
  await menu.getByRole('button', { name: 'Preguntar' }).click();
  const composer = page.getByRole('textbox', { name: 'Pregunta sobre el documento…' });
  await composer.fill('Ponme una nota al margen con una imagen');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Detener' })).toBeHidden();
  if (info.project.name !== 'desktop') {
    await page.getByRole('button', { name: 'Cerrar chat' }).click();
  }
  const tab = page.locator('[data-page="1"]').getByRole('button', { name: 'Abrir nota de Claude' });
  if (await tab.isVisible()) await tab.click();
  const note = page.locator('[data-page="1"]').getByRole('note', {
    name: 'Nota de Claude al margen',
  });
  await expect(note.getByTestId('note-image')).toHaveCount(1);
  await expect(note.getByRole('img', { name: 'Imagen buscada por Claude' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('margin-note-image.png') });
  await note.getByTestId('note-image').click();
  await expect(viewer).toContainText('E2E Author · CC BY 4.0');
  await expect(viewer.getByRole('link', { name: 'Fuente' })).toHaveAttribute(
    'href',
    'https://commons.wikimedia.org/wiki/File:E2e_1.png',
  );
  await viewer.getByRole('button', { name: 'Cerrar' }).click();
});

// A whiteboard kept on the PDF: saved from the board, opened again and edited, and Claude's
// proposal to keep its board.
test('the whiteboard is saved in a note on the PDF and edited again', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'board next to the chat on wide screens');
  await login(page);
  const docId = await seedDocument(
    page,
    'Pizarra guardada',
    tinyPdf([['La fotosintesis ocurre en los cloroplastos.']]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('cloroplastos');

  const composer = page.getByRole('textbox', { name: 'Pregunta sobre el documento…' });
  await composer.fill('Explícamelo en la pizarra');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Detener' })).toBeHidden();
  const thread = (await (
    await page.request.get(`/api/documents/${docId}/threads/active`)
  ).json()) as ThreadSummary;
  const board = async () =>
    (await (await page.request.get(`/api/threads/${thread.id}/whiteboard`)).json()) as Whiteboard;
  await expect.poll(async () => (await board()).applied.length).toBe(2);

  // "Guardar en el PDF" keeps a copy in a note at the top of the page being read.
  await page.getByRole('button', { name: 'Guardar en el PDF' }).click();
  await expect(page.getByText('Guardada en una nota de la p. 1')).toBeVisible();
  const marker = page
    .locator('[data-page="1"]')
    .getByRole('button', { name: 'Abrir la nota con la pizarra' });
  await expect(marker).toHaveCount(1);
  await page.getByRole('button', { name: 'Ir a la nota' }).click();
  const popover = page.getByTestId('annotation-popover');
  await expect(popover.getByTestId('note-board')).toBeVisible();
  await page.screenshot({ path: info.outputPath('board-note.png') });

  // "Nueva pizarra" starts over; the saved copy stays in the note.
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Nueva pizarra' }).click();
  await expect.poll(async () => (await board()).scene?.elements.length).toBe(0);

  // The note's board opens on the board again, linked: edits go to the note.
  await popover.getByTestId('note-board').click();
  await page
    .getByTestId('media-viewer')
    .getByRole('button', { name: 'Editar en la pizarra' })
    .click();
  await expect(page.getByTestId('board-linked')).toContainText(
    'Editando la pizarra guardada en la p. 1',
  );
  await expect.poll(async () => (await board()).linked?.page).toBe(1);
  await page.screenshot({ path: info.outputPath('board-linked.png') });
  expect(((await board()).scene?.elements ?? []).length).toBeGreaterThan(0);
  await page.getByTestId('board-linked').getByRole('button', { name: 'Terminar' }).click();
  await expect(page.getByTestId('board-linked')).toHaveCount(0);

  // Claude keeps its board on the PDF at once; the note follows the board until the next
  // question.
  await page.getByRole('tab', { name: 'Conversación' }).click();
  await composer.fill('Hazlo en la pizarra y guarda la pizarra');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Detener' })).toBeHidden();
  await expect(marker).toHaveCount(2);
  const kept = async () =>
    (
      (await (await page.request.get(`/api/documents/${docId}/annotations`)).json()) as Annotation[]
    ).find((a) => a.author === 'claude');
  expect((await kept())?.status).toBe('active');
  expect((await kept())?.board?.pending).toBe(true);
  await composer.fill('Gracias');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Detener' })).toBeHidden();
  await expect.poll(async () => (await kept())?.board?.pending).toBe(false);
});
