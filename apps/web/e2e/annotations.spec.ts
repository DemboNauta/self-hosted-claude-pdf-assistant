import { expect, test } from '@playwright/test';
import { login, openPanel, seedDocument, selectInPdf, tinyPdf } from './helpers';

// Phase 1 acceptance ("puedo subrayar y poner notas que persisten") plus Phase 2
// annotation features: Claude's proposals, saved marks, drawing, undo and export.
test('highlight, comment, undo, accept Claude proposals and export', async ({ page }, info) => {
  await login(page);
  const docId = await seedDocument(
    page,
    `Anotar ${info.project.name}`,
    tinyPdf([['La fotosintesis ocurre en los cloroplastos.', 'El ciclo de Calvin fija el CO2.']]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Calvin');
  const menu = page.getByRole('toolbar', { name: 'Acciones sobre la selección' });
  const highlights = page.locator('[data-page="1"] [data-annotation]');

  // Highlight with a meaning colour (F-ANN-01) and add a comment (F-ANN-02).
  await selectInPdf(page, 'ocurre en los cloroplastos');
  await menu.getByRole('button', { name: 'Subrayar: No lo entiendo' }).click();
  await expect(highlights).toHaveCount(1);
  const box = (await highlights.first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const popover = page.getByRole('dialog', { name: 'Editar anotación' });
  await popover.getByRole('textbox', { name: 'Comentario' }).fill('Repasar con el tema 2');
  await popover.getByRole('radio', { name: 'Importante' }).click();
  await popover.getByRole('button', { name: 'Borrar anotación' }).click();
  await expect(highlights).toHaveCount(0);

  // Undo brings it back with its comment (F-ANN-08); it persists after a reload.
  await page.keyboard.press('Control+z');
  await expect(highlights).toHaveCount(1);
  await page.reload();
  await expect(highlights).toHaveCount(1);
  await openPanel(page, 'Anotaciones');
  const panel = page.getByRole('complementary', { name: 'Anotaciones' });
  await expect(panel).toContainText('ocurre en los cloroplastos');
  await expect(panel).toContainText('Repasar con el tema 2');
  const exported = await page.request.get(`/api/documents/${docId}/export-annotated`);
  expect(exported.headers()['content-type']).toBe('application/pdf');
  expect((await exported.body()).includes(Buffer.from('/Highlight'))).toBe(true);
  await panel.getByRole('button', { name: 'Cerrar panel' }).click();

  // Claude proposes key ideas (F-ANN-04): shown dashed until accepted.
  // Closing the panel re-lays out the page (the text layer is rebuilt): retry the selection.
  await expect(async () => {
    await selectInPdf(page, 'El ciclo de Calvin fija');
    await expect(menu).toBeVisible({ timeout: 1000 });
  }).toPass();
  await menu.getByRole('button', { name: 'Preguntar' }).click();
  const composer = page.getByRole('textbox', { name: 'Pregunta sobre el documento…' });
  await composer.fill('Marca las ideas clave');
  await composer.press('Enter');
  await expect(highlights).toHaveCount(2);
  await openPanel(page, 'Anotaciones');
  await panel.getByRole('button', { name: 'Aceptar todas' }).click();
  await expect(panel.getByText('propuesta de Claude')).toHaveCount(0);
  await expect(panel).toContainText('De Claude');
});

test('draw by hand and erase', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'mouse drawing');
  await login(page);
  const docId = await seedDocument(page, 'Dibujo', tinyPdf('Dibujar aqui'));
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Dibujar');
  await page.getByRole('button', { name: 'Herramientas de anotación' }).first().click();
  await page.getByRole('button', { name: 'Dibujar a mano alzada' }).click();
  const pageBox = (await page.locator('[data-page="1"]').boundingBox())!;
  await page.mouse.move(pageBox.x + 100, pageBox.y + 200);
  await page.mouse.down();
  await page.mouse.move(pageBox.x + 200, pageBox.y + 260, { steps: 10 });
  await page.mouse.up();
  const strokes = page.locator('[data-page="1"] svg path[stroke="#1f6feb"]');
  await expect(strokes).toHaveCount(1);
  await page.getByRole('button', { name: 'Borrador' }).click();
  await page.mouse.click(pageBox.x + 150, pageBox.y + 230);
  await expect(strokes).toHaveCount(0);
});

test('draw around something, move the drawing and ask Claude about it', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'mouse drawing');
  await login(page);
  const docId = await seedDocument(
    page,
    'Marca',
    tinyPdf([['Primera linea sin marcar.', 'E = m c^2 es la formula marcada.']]),
  );
  await page.goto(`/read/${docId}`);
  const pageEl = page.locator('[data-page="1"]');
  await expect(pageEl.locator('.textLayer')).toContainText('formula marcada');
  const line = (await pageEl
    .locator('.textLayer span', { hasText: 'formula marcada' })
    .boundingBox())!;

  await page.getByRole('button', { name: 'Herramientas de anotación' }).first().click();
  await page.getByRole('button', { name: 'Dibujar a mano alzada' }).click();
  const ask = page.getByRole('button', { name: 'Preguntar a Claude sobre lo marcado' });
  await expect(ask).toBeDisabled();
  // Underline drawn one line too high, then moved down onto the formula.
  const y = line.y + line.height + 4 - 28;
  await page.mouse.move(line.x, y);
  await page.mouse.down();
  await page.mouse.move(line.x + line.width, y, { steps: 10 });
  await page.mouse.up();
  await expect(ask).toBeEnabled();

  const strokeY = async () => {
    const res = await page.request.get(`/api/documents/${docId}/annotations`);
    const list = (await res.json()) as { anchor: { strokes: { points: number[][] }[] } }[];
    return list[0]!.anchor.strokes[0]!.points[0]![1]!;
  };
  const y0 = await strokeY();
  await page.getByRole('button', { name: 'Seleccionar texto' }).click();
  const hit = pageEl.locator('path[data-drawing]');
  const hitBox = (await hit.boundingBox())!;
  const cx = hitBox.x + hitBox.width / 2;
  const cy = hitBox.y + hitBox.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 28, { steps: 8 });
  await page.mouse.up();
  await expect.poll(strokeY).toBeGreaterThan(y0 + 0.015);

  // Clicking the drawing opens its window; "Preguntar" attaches the marked area.
  // (The grab area is a transparent stroke, so click it with the mouse.)
  const moved = (await hit.boundingBox())!;
  await page.mouse.click(moved.x + moved.width / 2, moved.y + moved.height / 2);
  await page
    .getByRole('dialog', { name: 'Editar anotación' })
    .getByRole('button', { name: 'Preguntar' })
    .click();
  const attached = page.getByTestId('attached-mark');
  await expect(attached).toContainText('Tu marca en la p. 1');
  await expect(attached).toContainText('formula marcada');
  await expect(attached).not.toContainText('Primera linea');
  await page.getByRole('textbox', { name: 'Pregunta sobre el documento…' }).fill('Que significa?');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByText('Veo tu marca en la página 1 (con imagen)')).toBeVisible();
});

test('pin a note window, move it and find it open after a reload', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'mouse dragging');
  await login(page);
  const docId = await seedDocument(page, 'Fijar', tinyPdf('Texto con una nota fijada'));
  await page.request.post(`/api/documents/${docId}/annotations`, {
    data: {
      items: [
        {
          type: 'highlight',
          page: 1,
          color: 'yellow',
          content: 'Mi nota',
          anchor: { quote: 'nota fijada' },
        },
      ],
    },
  });
  await page.goto(`/read/${docId}`);
  const highlight = page.locator('[data-page="1"] [data-annotation]');
  await expect(highlight).toHaveCount(1);
  const box = (await highlight.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const win = page.getByRole('dialog', { name: 'Editar anotación' });
  await expect(win).toBeVisible();

  const before = (await win.boundingBox())!;
  await page.mouse.move(before.x + 40, before.y + 12);
  await page.mouse.down();
  await page.mouse.move(before.x + 80, before.y + 112, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await win.boundingBox())!.y).toBeGreaterThan(before.y + 50);
  const moved = (await win.boundingBox())!;
  await win.getByRole('button', { name: 'Dejar abierta' }).click();
  await expect(win.getByRole('button', { name: 'No dejar abierta' })).toBeVisible();

  // Clicking elsewhere closes unpinned windows only.
  await page.mouse.click(box.x + 5, box.y + 300);
  await expect(win).toBeVisible();
  await page.reload();
  await expect(win).toBeVisible();
  await expect(win.getByRole('textbox', { name: 'Comentario' })).toHaveValue('Mi nota');
  const after = (await win.boundingBox())!;
  expect(Math.abs(after.x - moved.x)).toBeLessThan(3);
  expect(Math.abs(after.y - moved.y)).toBeLessThan(3);

  // Closing it unpins it: gone after the next reload.
  await win.getByRole('button', { name: 'Cerrar panel' }).click();
  await page.reload();
  await expect(highlight).toHaveCount(1);
  await expect(win).toHaveCount(0);
});

// F-ANN-01 configurable meanings + F-UX-03 shortcuts: rename a colour in Settings,
// then highlight with the number key.
test('configure colour meanings and highlight with a shortcut', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'keyboard shortcuts are for desktop');
  await login(page);
  await page.goto('/settings');
  await page.getByRole('textbox', { name: 'Significado del color 5' }).fill('Para el examen');
  await page.locator('#palette ~ button', { hasText: 'Guardar' }).first().click();
  await expect(page.getByRole('status')).toHaveText('Guardado');

  const docId = await seedDocument(page, 'Atajos', tinyPdf('Texto para subrayar con el teclado.'));
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('teclado');
  await selectInPdf(page, 'subrayar con el teclado');
  await expect(page.getByRole('button', { name: 'Subrayar: Para el examen' })).toBeVisible();
  await page.keyboard.press('5');
  await expect(page.locator('[data-page="1"] [data-annotation]')).toHaveCount(1);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Atajos de teclado' })).toBeVisible();
});
