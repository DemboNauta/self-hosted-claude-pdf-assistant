import { expect, test } from '@playwright/test';
import { login, seedDocument, tinyPdf } from './helpers';

// F-SRC-01/02: "¿dónde hablaba de…?" across the library, then jump to the page.
test('search the whole library and open a result', async ({ page }, info) => {
  await login(page);
  const word = `Kreb${info.project.name}`;
  const docId = await seedDocument(
    page,
    `Buscar ${info.project.name}`,
    tinyPdf([['Introduccion.'], [`El ciclo de ${word} ocurre en la mitocondria.`]]),
  );
  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Buscar' }).fill(word);
  const hit = page.getByTestId('search-hit');
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('Página 2');
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/read/${docId}[?]page=2`));
  await expect(page.getByRole('textbox', { name: 'Página' })).toHaveValue('2');
});
