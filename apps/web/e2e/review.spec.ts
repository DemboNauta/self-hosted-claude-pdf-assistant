import { expect, test } from '@playwright/test';
import { login, seedDocument, selectInPdf, tinyPdf } from './helpers';

// Phase 3 acceptance (review part): flashcards from a selection and from Claude, FSRS
// review, "Repaso de hoy" on Home and the statistics.
test('create flashcards, review them and see today and the stats', async ({ page }, info) => {
  await login(page);
  const name = `Repaso ${info.project.name}`;
  const docId = await seedDocument(page, name, tinyPdf('La mitocondria produce ATP.'));
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('mitocondria');
  const menu = page.getByRole('toolbar', { name: 'Acciones sobre la selección' });

  await selectInPdf(page, 'La mitocondria produce ATP');
  await menu.getByRole('button', { name: 'Crear flashcard' }).click();
  const dialog = page.getByRole('dialog', { name: 'Crear flashcard' });
  await dialog
    .getByRole('textbox', { name: 'Pregunta (anverso)' })
    .fill(`¿Qué produce la mitocondria? ${name}`);
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog).toBeHidden();

  // Claude writes another card (create_flashcards), ready to review at once.
  await selectInPdf(page, 'produce ATP');
  await menu.getByRole('button', { name: 'Preguntar' }).click();
  const composer = page.getByRole('textbox', { name: 'Pregunta sobre el documento…' });
  await composer.fill('Hazme tarjetas');
  await composer.press('Enter');
  await expect(page.getByTestId('assistant-message').last()).toContainText('Respuesta de prueba');

  await page.goto(
    `/review?f=s:${await page.evaluate(async (n) => {
      const tree = await (await fetch('/api/library')).json();
      return tree.subjects.find((s: { name: string }) => s.name === n).id;
    }, name)}`,
  );
  await expect(page.getByTestId('proposal')).toHaveCount(0);

  // Cards without wrong answers get them from Claude and are answered by choosing:
  // a right answer moves on by itself, a wrong one shows the right one first.
  const card = page.getByTestId('flashcard');
  await expect(card).toContainText(`¿Qué produce la mitocondria? ${name}`);
  const options = card.getByRole('list', { name: 'Opciones' }).getByRole('button');
  await expect(options).toHaveCount(4);
  await options.filter({ hasText: 'La mitocondria produce ATP' }).click();
  await expect(card).toContainText('¡Correcto!');
  await expect(card).toContainText('¿Qué dice este fragmento?');
  await expect(options).toHaveCount(4);
  // A hint from Claude: a right answer then counts as "Difícil".
  await card.getByRole('button', { name: 'Pedir pista a Claude' }).click();
  await expect(card.getByTestId('hint')).toContainText('Pista de prueba.');
  await options.filter({ hasText: 'Opción falsa A' }).click();
  await expect(card).toContainText('No era esa');
  await card.getByRole('button', { name: 'Siguiente' }).click();
  // Rated "again": the card comes back in a minute, nothing else is due now.
  await expect(page.getByText(/Nada pendiente/)).toBeVisible();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Repaso de hoy' })).toBeVisible();
  await expect(page.getByText('Respuesta de prueba').first()).toBeVisible();
  await page.goto('/stats');
  await expect(page.getByText('1 día', { exact: true })).toBeVisible();
  // The chart tells what each day was: today by default, any other day on hover or tap.
  const detail = page.getByTestId('chart-detail');
  await expect(detail).toContainText('Hoy');
  await expect(detail).toContainText('tarjeta');
  const bars = page.getByRole('group', { name: 'Últimos 30 días' }).getByRole('button');
  await expect(bars).toHaveCount(30);
  await bars.first().click();
  await expect(detail).toContainText('Sin estudio');
  await expect(detail).not.toContainText('Hoy');
});

// Claude writes cards from what was read: on demand in "Repaso" (choosing the PDFs) and
// a few every day with today's brief on "Inicio", ready to review.
test('ask Claude for cards from what was read and see them on Home', async ({ page }, info) => {
  await login(page);
  const name = `Cartas ${info.project.name}`;
  const docId = await seedDocument(page, name, tinyPdf('Las enzimas aceleran reacciones.'));
  await page.request.put(`/api/documents/${docId}/position`, { data: { page: 1, scroll: 0 } });

  await page.goto('/review');
  await page.getByRole('button', { name: 'Crear tarjetas con Claude' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nuevas tarjetas con Claude' });
  await dialog.getByRole('checkbox', { name: new RegExp(`${name} .*leído`) }).check();
  await dialog.getByRole('button', { name: 'Crear tarjetas' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status')).toContainText('Claude ha creado 1 tarjeta nueva');
  await expect(page.getByTestId('flashcard')).toContainText('¿Qué dice la página 1?');

  await page.goto('/');
  await expect(page.getByTestId('claude-cards')).toContainText('Claude te ha preparado');
  await expect(page.getByRole('group', { name: 'Últimos 30 días' })).toBeVisible();
  await expect(page.getByText('Conceptos flojos')).toBeVisible();
  await expect(page.getByText(/^[1-9]\d* pendientes?$/)).toBeVisible();
});
