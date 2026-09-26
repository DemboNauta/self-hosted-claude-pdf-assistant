import { expect, test } from '@playwright/test';
import { login, openPanel, seedDocument, selectInPdf, tinyPdf } from './helpers';

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
  await openPanel(page, 'Buscar en el documento');
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

// F-LIB-04: leaving the reader and opening the document again (without reloading the
// app) resumes at the page where the reading stopped.
test('reopening a document resumes at the last page read', async ({ page }, info) => {
  await login(page);
  const docId = await seedDocument(
    page,
    `Retomar ${info.project.name}`,
    tinyPdf([['Pagina uno.'], ['Pagina dos.'], ['Pagina tres.'], ['Pagina cuatro.']]),
  );
  const { topicId } = (await (await page.request.get(`/api/documents/${docId}`)).json()) as {
    topicId: string;
  };
  await page.goto(`/library/t/${topicId}`);
  const card = page.locator(`a[href="/read/${docId}"]`).first();
  await card.click();
  const pageInput = page.getByRole('textbox', { name: 'Página' });
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Pagina uno');

  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/api/documents/${docId}/position`) && r.request().method() === 'PUT',
  );
  await pageInput.fill('3');
  await pageInput.press('Enter');
  await expect(pageInput).toHaveValue('3');
  await saved;

  // Back to the topic and into the document again, all inside the app.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/library/t/${topicId}`));
  await card.click();
  await expect(page.locator('[data-page="3"] .textLayer')).toContainText('Pagina tres');
  await expect(pageInput).toHaveValue('3');
});

// F-POINT-01..03: Claude's marks appear on the page, grouped under the answer, and go
// away with the next question.
test('Claude points at the page and the marks clear with the next question', async ({
  page,
}, info) => {
  await login(page);
  const docId = await seedDocument(
    page,
    `Señales ${info.project.name}`,
    tinyPdf([['La fotosintesis ocurre en los cloroplastos.', 'El ciclo de Calvin fija el CO2.']]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Calvin');

  await selectInPdf(page, 'El ciclo de Calvin fija');
  await page
    .getByRole('toolbar', { name: 'Acciones sobre la selección' })
    .getByRole('button', { name: 'Preguntar' })
    .click();
  const composer = page.getByRole('textbox', { name: 'Pregunta sobre el documento…' });
  await composer.fill('Señala dónde está esto');
  await composer.press('Enter');

  await expect(page.locator('[data-page="1"] [data-testid="claude-pointers"]')).toBeVisible();
  await expect(page.getByText('Claude ha señalado en la p. 1')).toBeVisible();
  await expect(page.locator('[data-page="1"]').getByText('Aquí')).toBeVisible();

  // Wait for the answer to finish before the next question.
  await expect(page.getByRole('button', { name: 'Detener' })).toBeHidden();
  await composer.fill('Gracias');
  await composer.press('Enter');
  await expect(page.getByTestId('assistant-message')).toHaveCount(2);
  await expect(page.locator('[data-testid="claude-pointers"]')).toHaveCount(0);
});

// F-MEM-04/05: what Claude saves through its tools shows up, read-only, in "Memoria".
test('Claude remembers preferences and difficult concepts', async ({ page }, info) => {
  await login(page);
  const docId = await seedDocument(
    page,
    `Memoria ${info.project.name}`,
    tinyPdf('El ciclo de Calvin.'),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"]')).toBeVisible();
  const chat = page.locator('section[aria-label="Claude"]');
  if (!(await chat.isVisible()))
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  const composer = page.getByRole('textbox', { name: 'Pregunta sobre el documento…' });
  await composer.fill(`Recuerda que prefiero ejemplos prácticos ${info.project.name}`);
  await composer.press('Enter');
  await expect(page.getByTestId('assistant-message').last()).toContainText('Respuesta de prueba');
  await page.goto('/memory');
  await expect(
    page.getByText(`que prefiero ejemplos prácticos ${info.project.name}`),
  ).toBeVisible();
  await expect(page.getByRole('meter', { name: 'Dominio de Ciclo de Calvin' })).toBeVisible();
});

// F-CHAT-08: ask about a whole topic; citations open the cited document.
test('chat about a whole topic and follow a citation', async ({ page }, info) => {
  await login(page);
  const docId = await seedDocument(
    page,
    `Tema entero ${info.project.name}`,
    tinyPdf('Primera pagina.'),
  );
  const detail = await (await page.request.get(`/api/documents/${docId}`)).json();
  await page.goto(`/library/t/${detail.topicId}`);
  await page.getByRole('link', { name: 'Preguntar sobre el tema' }).click();
  await expect(page.getByText('Chat del tema')).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Pregunta sobre el documento…' });
  await composer.fill('¿De qué trata este tema?');
  await composer.press('Enter');
  const answer = page.getByTestId('assistant-message').last();
  await expect(answer).toContainText('Respuesta de prueba');
  await answer.getByTestId('citation').click();
  await expect(page).toHaveURL(new RegExp(`/read/${docId}`));
  await expect(page.locator('[data-page="1"]')).toBeVisible();
});
