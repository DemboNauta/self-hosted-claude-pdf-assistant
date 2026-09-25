import { expect, test } from '@playwright/test';

// Phase 0 acceptance: log in, and Settings confirms Claude answers via the subscription.
test('login and Claude connection status', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Contraseña').fill('wrong');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toHaveText('Contraseña incorrecta.');

  await page.getByLabel('Contraseña').fill('e2e-password');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByTestId('claude-state')).toHaveText('Conectado con tu suscripción');
  await expect(page.getByText('Token OAuth (CLAUDE_CODE_OAUTH_TOKEN)')).toBeVisible();

  // Session persists across reloads.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
});
