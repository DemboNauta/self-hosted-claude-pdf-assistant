import { expect, test, type Page } from '@playwright/test';
import { login, seedDocument, tinyPdf } from './helpers';

/** Selects `text` inside the PDF text layer, as a drag or long-press would. */
async function selectInPdf(page: Page, text: string) {
  await page.evaluate((needle) => {
    const span = [...document.querySelectorAll('.textLayer span')].find((s) =>
      s.textContent?.includes(needle),
    );
    if (!span?.firstChild) throw new Error(`"${needle}" not in the text layer`);
    const start = span.textContent!.indexOf(needle);
    const range = document.createRange();
    range.setStart(span.firstChild, start);
    range.setEnd(span.firstChild, start + needle.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, text);
}

// Phase 1 acceptance: read on desktop and mobile, ask about a selection, get a streamed
// answer with a citation that jumps to the page and highlights the quote.
test('read a PDF and ask Claude about a selection', async ({ page }, info) => {
  await login(page);
  const docId = await seedDocument(
    page,
    `Lectura ${info.project.name}`,
    tinyPdf([
      ['Tema 1. La fotosintesis.', 'La fotosintesis ocurre en los cloroplastos.'],
      ['Tema 2. El ciclo de Calvin.', 'El ciclo de Calvin fija el CO2 atmosferico.'],
    ]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"]')).toBeVisible();
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('cloroplastos');

  // In-document search jumps to the page and highlights the term (F-VIS-02).
  await page.getByRole('button', { name: 'Buscar en el documento' }).click();
  await page.getByRole('searchbox', { name: 'Buscar en el documento' }).fill('Calvin');
  await page.getByRole('button', { name: /Página 2/ }).click();
  await expect(page.getByRole('textbox', { name: 'Página' })).toHaveValue('2');
  if (await page.getByRole('button', { name: 'Cerrar panel' }).isVisible()) {
    await page.getByRole('button', { name: 'Cerrar panel' }).click();
  }

  // Selection menu → "Explícamelo fácil" (F-CHAT-02), streamed Markdown + KaTeX (F-CHAT-05).
  await page.getByRole('textbox', { name: 'Página' }).fill('1');
  await page.getByRole('textbox', { name: 'Página' }).press('Enter');
  await selectInPdf(page, 'ocurre en los cloroplastos');
  await page
    .getByRole('toolbar', { name: 'Acciones sobre la selección' })
    .getByRole('button', { name: 'Explícamelo fácil' })
    .click();
  const answer = page.getByTestId('assistant-message').last();
  await expect(answer).toContainText('Respuesta de prueba');
  await expect(answer.locator('.katex')).toBeVisible();
  await expect(page.getByTestId('user-message').last()).toContainText('ocurre en los cloroplastos');

  // Citation chip → page 1 with the quoted fragment flashing (F-CHAT-04, F-VIS-03).
  await answer.getByTestId('citation').click();
  await expect(page.getByRole('textbox', { name: 'Página' })).toHaveValue('1');
  await expect(page.locator('[data-page="1"] .animate-flash').first()).toBeVisible();

  // The conversation is kept with the document (F-CHAT-07).
  await page.reload();
  await expect(page.locator('[data-page="1"]')).toBeVisible();
  const chat = page.locator('section[aria-label="Claude"]');
  // Desktop remembers the open panel; the mobile sheet starts closed.
  if (!(await chat.isVisible())) {
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  }
  await expect(chat.getByTestId('user-message').first()).toContainText('cloroplastos');
});
