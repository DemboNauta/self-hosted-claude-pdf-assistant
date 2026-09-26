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

  // Claude proposes another card (create_flashcards).
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
  await expect(page.getByTestId('proposal')).toHaveCount(1);
  await page.getByRole('button', { name: 'Aceptar todas' }).click();
  await expect(page.getByTestId('proposal')).toHaveCount(0);

  const card = page.getByTestId('flashcard');
  await expect(card).toContainText(`¿Qué produce la mitocondria? ${name}`);
  await card.getByRole('button', { name: 'Mostrar respuesta' }).click();
  await expect(card).toContainText('La mitocondria produce ATP');
  await card.getByRole('button', { name: /^Bien/ }).click();
  await expect(card).toContainText('¿Qué dice este fragmento?');
  await card.getByRole('button', { name: 'Mostrar respuesta' }).click();
  await card.getByRole('button', { name: /^Fácil/ }).click();
  await expect(page.getByText(/Nada pendiente/)).toBeVisible();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Repaso de hoy' })).toBeVisible();
  await expect(page.getByText('Respuesta de prueba').first()).toBeVisible();
  await page.goto('/stats');
  await expect(page.getByText('1 día', { exact: true })).toBeVisible();
});
