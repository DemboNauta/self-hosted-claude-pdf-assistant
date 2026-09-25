import { expect, test, type Page } from '@playwright/test';
import { login, tinyPdf } from './helpers';

/** On mobile the tree and the topic view are separate screens. */
async function showTree(page: Page) {
  const back = page.getByRole('link', { name: 'Volver a asignaturas' });
  if (await back.isVisible()) await back.click();
}

async function menu(page: Page, name: string, action: string) {
  await page.getByRole('button', { name: `Más acciones: ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

async function fillDialog(page: Page, value: string, submit: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill(value);
  await dialog.getByRole('button', { name: submit }).click();
  await expect(dialog).toBeHidden();
}

// Phase 1 acceptance (library part): F-LIB-01..03, F-ING-01/05 and the minimal trash.
test('organise subjects and topics, upload, move and restore PDFs', async ({ page }, info) => {
  // Desktop and mobile runs share one server: keep names unique per project.
  const subject = `Biología ${info.project.name}`;
  const plants = `Plantas ${info.project.name}`;
  const cells = `Células ${info.project.name}`;
  const docTitle = `La fotosíntesis ${info.project.name}`;
  await login(page);
  await page.goto('/library');

  await page.getByRole('button', { name: 'Nueva asignatura' }).click();
  await fillDialog(page, subject, 'Crear');
  await menu(page, subject, 'Nuevo tema');
  await fillDialog(page, plants, 'Crear');
  await expect(page.getByRole('heading', { name: plants })).toBeVisible();
  await expect(page.getByText('Este tema aún no tiene PDFs.')).toBeVisible();

  // Upload through the chunked API; the card shows processing, then the page count.
  await page.getByTestId('upload-input').setInputFiles([
    { name: 'fotosintesis.pdf', mimeType: 'application/pdf', buffer: tinyPdf('Fotosintesis') },
    { name: 'virus.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ not a pdf') },
  ]);
  await expect(page.getByText('No es un PDF')).toBeVisible();
  const card = page.getByTestId('document-card').filter({ hasText: 'fotosintesis' });
  await expect(card.getByText('1 página')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('Sin abrir')).toBeVisible();
  await expect(card.locator('img')).toBeVisible();

  await menu(page, 'fotosintesis', 'Renombrar');
  await fillDialog(page, docTitle, 'Guardar');
  await expect(page.getByRole('link', { name: docTitle })).toBeVisible();

  // Second topic, then move the PDF there from the card menu (F-LIB-02).
  await showTree(page);
  await menu(page, subject, 'Nuevo tema');
  await fillDialog(page, cells, 'Crear');
  await expect(page.getByRole('heading', { name: cells })).toBeVisible();
  await showTree(page);
  await page.getByRole('link', { name: plants }).click();
  await menu(page, docTitle, 'Mover a otro tema');
  await page.getByRole('dialog').getByRole('combobox').selectOption({ label: cells });
  await page.getByRole('dialog').getByRole('button', { name: 'Mover a otro tema' }).click();
  await expect(page.getByText('Este tema aún no tiene PDFs.')).toBeVisible();
  await showTree(page);
  await page.getByRole('link', { name: cells }).click();
  await expect(page.getByRole('link', { name: docTitle })).toBeVisible();

  // Trash and restore into another topic (owner decision: restore asks where).
  await menu(page, docTitle, 'Mover a la papelera');
  await page.getByRole('dialog').getByRole('button', { name: 'Mover a la papelera' }).click();
  await expect(page.getByText('Este tema aún no tiene PDFs.')).toBeVisible();
  await page.goto('/library/trash');
  await expect(page.getByText(docTitle)).toBeVisible();
  await page
    .getByRole('listitem')
    .filter({ hasText: docTitle })
    .getByRole('button', { name: 'Restaurar' })
    .click();
  await page.getByRole('dialog').getByRole('combobox').selectOption({ label: plants });
  await page.getByRole('dialog').getByRole('button', { name: 'Restaurar' }).click();
  await expect(page.getByText(docTitle)).toBeHidden();

  // Deleting a topic with PDFs warns that they go to the trash.
  await page.goto('/library');
  await showTree(page);
  await menu(page, plants, 'Borrar');
  await expect(page.getByRole('dialog')).toContainText('Sus 1 PDF irán a la papelera');
  await page.getByRole('dialog').getByRole('button', { name: 'Borrar' }).click();
  await expect(page.getByRole('link', { name: plants })).toBeHidden();
  await page.goto('/library/trash');
  await expect(page.getByText(docTitle)).toBeVisible();
});

test('drag and drop: reorder subjects by keyboard and move a PDF onto a topic', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'pointer drag onto the tree needs both panes');
  const [a, b] = ['Arrastre A', 'Arrastre B'];
  await login(page);
  await page.goto('/library');
  for (const name of [a, b]) {
    await page.getByRole('button', { name: 'Nueva asignatura' }).click();
    await fillDialog(page, name, 'Crear');
  }
  const subjectNames = () =>
    page
      .getByRole('list', { name: 'Asignaturas' })
      .locator(':scope > li')
      .allInnerTexts()
      .then((texts) =>
        texts.map((x) => x.split('\n')[0]!.trim()).filter((x) => x.startsWith('Arrastre')),
      );
  expect(await subjectNames()).toEqual([a, b]);

  // Keyboard sorting (accessibility): Space to lift, ArrowDown, Space to drop.
  const handleOfA = page
    .getByRole('list', { name: 'Asignaturas' })
    .locator(':scope > li')
    .filter({ hasText: a })
    .getByRole('button', { name: 'Arrastrar para reordenar' })
    .first();
  await handleOfA.focus();
  const live = page.locator('[id^=DndLiveRegion]');
  await page.keyboard.press('Space');
  await expect(live).toContainText('Draggable item subject:');
  await page.keyboard.press('ArrowDown');
  // Wait until dnd-kit reports the item over its neighbour before dropping.
  await expect
    .poll(async () => {
      const m = /draggable item subject:(\w+) was moved over droppable area subject:(\w+)/i.exec(
        await live.innerText(),
      );
      return m ? m[1] !== m[2] : false;
    })
    .toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(subjectNames).toEqual([b, a]);
  await page.reload();
  await expect.poll(subjectNames).toEqual([b, a]);

  // Move a PDF by dragging its card onto another topic in the tree.
  await menu(page, a, 'Nuevo tema');
  await fillDialog(page, 'Origen', 'Crear');
  await menu(page, a, 'Nuevo tema');
  await fillDialog(page, 'Destino', 'Crear');
  await page.getByRole('link', { name: 'Origen' }).click();
  await page.getByTestId('upload-input').setInputFiles({
    name: 'arrastrado.pdf',
    mimeType: 'application/pdf',
    buffer: tinyPdf('Arrastrado'),
  });
  const handle = page.getByRole('button', { name: 'Arrastrar para reordenar: arrastrado' });
  const target = page.getByRole('link', { name: 'Destino' });
  await handle.hover();
  await page.mouse.down();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2, { steps: 15 });
  await page.mouse.move(box.x + 12, box.y + box.height / 2, { steps: 2 });
  await page.mouse.up();
  await expect(page.getByText('Este tema aún no tiene PDFs.')).toBeVisible();
  await target.click();
  await expect(page.getByTestId('document-card').filter({ hasText: 'arrastrado' })).toBeVisible();
});
