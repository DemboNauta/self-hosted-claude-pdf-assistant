import { expect, test } from '@playwright/test';
import { login, seedDocument, tinyPdf } from './helpers';

/** A small pink PNG, as if it were a screenshot. */
const SHOT =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAYAAABr5z2BAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAbSURBVCiRY7xmnPOfgQLARInmUQNGDRg8BgAAmvkCjC7fGvoAAAAASUVORK5CYII=';

// Screenshots in the chat: chosen from a file and pasted, sent to Claude with the
// question and kept in the conversation.
test('attaches screenshots to a question', async ({ page }, info) => {
  await login(page);
  const docId = await seedDocument(
    page,
    `Capturas ${info.project.name}`,
    tinyPdf([['La fotosintesis ocurre en los cloroplastos.']]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText('fotosintesis');
  if (info.project.name !== 'desktop') {
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  }

  // One from a file (the attach button), one pasted into the composer.
  await page.getByTestId('chat-attach-input').setInputFiles({
    name: 'captura.png',
    mimeType: 'image/png',
    buffer: Buffer.from(SHOT, 'base64'),
  });
  const composer = page.getByRole('textbox', { name: 'Pregunta sobre el documento…' });
  await composer.focus();
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'pegada.png', { type: 'image/png' }));
    document.activeElement!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, SHOT);
  const pending = page.getByTestId('pending-images');
  await expect(pending.locator('li')).toHaveCount(2);
  await expect(pending.getByRole('status')).toHaveCount(0);

  // Removing one and adding it again works too.
  await pending.getByRole('button', { name: 'Quitar imagen' }).first().click();
  await expect(pending.locator('li')).toHaveCount(1);
  await page.getByTestId('chat-attach-input').setInputFiles({
    name: 'otra.png',
    mimeType: 'image/png',
    buffer: Buffer.from(SHOT, 'base64'),
  });
  await expect(pending.getByRole('status')).toHaveCount(0);
  await expect(pending.locator('li')).toHaveCount(2);

  await composer.fill('¿Qué ves en las capturas?');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Detener' })).toBeHidden();
  await expect(page.getByTestId('assistant-message').last()).toContainText(
    'Veo 2 captura(s) adjunta(s)',
  );
  await expect(page.getByTestId('pending-images')).toHaveCount(0);
  const sent = page.getByTestId('user-message').last().getByTestId('message-images');
  await expect(sent.locator('img')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('chat-images.png') });

  // They stay in the conversation and open full size.
  await page.reload();
  if (info.project.name !== 'desktop') {
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  }
  const kept = page.getByTestId('user-message').last().getByTestId('message-images');
  await expect(kept.locator('img')).toHaveCount(2);
  await kept.getByRole('button', { name: 'Ver imagen 1' }).click();
  const viewer = page.getByTestId('chat-image-viewer');
  await expect(viewer.locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});
