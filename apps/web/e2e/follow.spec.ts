import { expect, test } from '@playwright/test';
import { login, seedDocument, tinyPdf } from './helpers';

// Visual interaction block 4: Claude only moves the reader with "Seguir a Claude" on
// (otherwise it offers a button), opens pages side by side, numbers steps, writes
// callouts, and the student can ask about one of its marks.
test('follow Claude, split view, numbered marks and asking about a mark', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'split view and the side toolbar are desktop only');
  await login(page);
  const docId = await seedDocument(
    page,
    `Seguir ${info.project.name}`,
    tinyPdf([['Primera pagina del documento.'], ['Segunda pagina del documento.']]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Primera');
  const composer = page.getByRole('textbox', { name: 'Pregunta sobre el documento…' });
  const pageBox = page.getByRole('textbox', { name: 'Página' });
  const ask = async (text: string) => {
    await composer.fill(text);
    await composer.press('Enter');
    await expect(page.getByRole('button', { name: 'Detener' })).toBeHidden();
  };

  // Off by default: Claude offers to go instead of moving the reader.
  await ask('Ve a la página donde lo explica');
  await expect(pageBox).toHaveValue('1');
  const offer = page.getByTestId('nav-offer');
  await expect(offer).toContainText('Claude te lleva a p. 2');
  await offer.getByRole('button', { name: 'Ir' }).click();
  await expect(pageBox).toHaveValue('2');

  // With "Seguir a Claude" on, it moves the reader itself.
  await pageBox.fill('1');
  await pageBox.press('Enter');
  await expect(pageBox).toHaveValue('1');
  const follow = page.getByRole('button', { name: 'Seguir a Claude' });
  await follow.click();
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await ask('Ve a la página otra vez');
  await expect(pageBox).toHaveValue('2');
  await expect(offer).toBeHidden();

  // Side by side: the other page opens next to the reader.
  await ask('Ponme la segunda al lado');
  const side = page.getByTestId('side-pane');
  await expect(side).toBeVisible();
  await expect(side.getByTestId('side-page')).toHaveText('p. 2 de 2');
  await side.getByRole('button', { name: 'Cerrar la vista partida' }).click();
  await expect(side).toBeHidden();

  // Numbered badges and a callout; "?" attaches the marks to the next question.
  await pageBox.fill('1');
  await pageBox.press('Enter');
  await ask('Numera los pasos');
  const marks = page.locator('[data-page="1"] [data-testid="claude-pointers"]');
  await expect(marks.locator('text').first()).toHaveText('1');
  await expect(page.locator('[data-page="1"]').getByTestId('pointer-callout')).toHaveText(
    'Aquí empieza el proceso',
  );
  await page.locator('[data-page="1"]').getByTestId('pointer-ask').click();
  await expect(page.getByTestId('attached-pointed')).toContainText('Señal de Claude en la p. 1');
  await ask('¿Por qué empieza aquí?');
  await expect(page.getByTestId('user-message').last()).toContainText('Señal de Claude en la p. 1');
});
