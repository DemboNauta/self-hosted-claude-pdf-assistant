import { expect, test } from '@playwright/test';
import { login, openPanel, seedDocument, tinyPdf } from './helpers';

// Visual schemas: "Esquema visual" mode over a page range, drawn in the chat, listed in
// the reader panel and on the general "Esquemas" page.
test('ask for a diagram of some pages and find it again', async ({ page }, info) => {
  await login(page);
  const title = `Esquemas ${info.project.name}`;
  const docId = await seedDocument(
    page,
    title,
    tinyPdf([['La fotosintesis.'], ['Fase luminosa.'], ['Ciclo de Calvin.']]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('fotosintesis');
  const chat = page.locator('section[aria-label="Claude"]');
  if (!(await chat.isVisible()))
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();

  await chat.getByRole('radio', { name: 'Esquema visual' }).click();
  const scope = chat.getByRole('group', { name: 'Alcance del esquema' });
  await scope.getByRole('radio', { name: 'Páginas' }).check();
  await scope.getByRole('spinbutton', { name: 'Desde la página' }).fill('2');
  await scope.getByRole('spinbutton', { name: 'Hasta la página' }).fill('3');
  await chat.getByRole('button', { name: 'Enviar' }).click();

  // Drawn in the answer (Mermaid SVG), with a link to the pages it covers.
  const inChat = chat.getByTestId('assistant-message').last().getByTestId('diagram');
  await expect(inChat.locator('.diagram-svg svg')).toBeVisible({ timeout: 20_000 });
  await expect(inChat).toContainText('Esquema de prueba');
  await expect(inChat).toContainText('p. 2–3');

  // Listed with the PDF…
  await openPanel(page, 'Esquemas');
  const panel = page.getByRole('complementary', { name: 'Esquemas' });
  await expect(panel.getByText('Esquema de prueba')).toBeVisible();
  await panel.getByRole('button', { name: /^Esquema de prueba/ }).click();
  const viewer = page.getByRole('dialog', { name: 'Esquema de prueba' });
  await expect(viewer.locator('.diagram-svg svg')).toBeVisible();
  await viewer.getByRole('button', { name: 'Cerrar esquema' }).click();

  // …and on the general page, grouped under the document.
  await page.goto('/diagrams');
  const group = page.getByRole('region', { name: title });
  await expect(group.getByText('Esquema de prueba')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await group.getByRole('button', { name: 'Borrar esquema: Esquema de prueba' }).click();
  await expect(group).toHaveCount(0);
});
