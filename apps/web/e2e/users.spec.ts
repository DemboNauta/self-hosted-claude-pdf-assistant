import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Multi-user: the admin invites someone, who signs up, starts with an empty library
// and connects their own Claude token.
test('invitation sign-up, isolated library and own Claude token', async ({ page, browser }) => {
  // The e2e server is shared by the desktop and mobile runs: names must be unique.
  const username = `marta${Date.now() % 1_000_000}`;
  await login(page);
  await page.goto('/admin');
  await page.getByLabel('Para quién es (opcional)').fill('Marta');
  await page.getByRole('button', { name: 'Crear enlace' }).click();
  const link = await page.getByTestId('invitation-link').inputValue();
  expect(link).toContain('/invite/');

  const other = await browser.newContext();
  const guest = await other.newPage();
  await guest.goto(link);
  await guest.getByLabel('Usuario (para entrar)').fill(username);
  await guest.getByLabel('Contraseña').fill('marta-password');
  await guest.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(guest.getByRole('heading', { name: 'Inicio' })).toBeVisible();

  await guest.goto('/library');
  await expect(guest.getByText('Tu biblioteca está vacía.', { exact: false })).toBeVisible();

  await guest.goto('/settings');
  await expect(guest.getByTestId('claude-state')).toHaveText('Sin conectar');
  await guest.getByLabel('Token (CLAUDE_CODE_OAUTH_TOKEN)').fill(`sk-ant-oat01-${'x'.repeat(40)}`);
  await guest.getByRole('button', { name: 'Guardar token' }).click();
  await expect(guest.getByTestId('claude-token-state')).toHaveText('Token guardado');
  await expect(guest.getByTestId('claude-state')).toHaveText('Conectado con tu suscripción');

  // The link works only once, and the admin sees the new account.
  await guest.goto(link);
  await expect(guest.getByRole('alert')).toContainText('no es válida');
  await other.close();

  await page.reload();
  await expect(page.getByText(`Usada por ${username}`)).toBeVisible();
  const account = page.getByRole('listitem').filter({ hasText: username });
  await expect(account.filter({ hasText: 'Claude conectado' })).toBeVisible();
});

// The admin lets an account without a token use the admin's Claude subscription.
test("admin shares the server's Claude with a user", async ({ page, browser }) => {
  const username = `pablo${Date.now() % 1_000_000}`;
  await login(page);
  await page.goto('/admin');
  await page.getByLabel('Usuario').fill(username);
  await page.getByLabel('Contraseña inicial').fill('pablo-password');
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  const account = page.getByRole('listitem').filter({ hasText: username });
  await expect(account.getByText('Sin token de Claude', { exact: false })).toBeVisible();

  page.once('dialog', (d) => void d.accept());
  await account.getByRole('button', { name: 'Dejar usar mi Claude' }).click();
  await expect(account.getByText('Usa tu suscripción de Claude', { exact: false })).toBeVisible();

  const other = await browser.newContext();
  const guest = await other.newPage();
  await login(guest, username, 'pablo-password');
  await guest.goto('/settings');
  await expect(guest.getByText('El administrador te deja usar su suscripción')).toBeVisible();
  await expect(guest.getByTestId('claude-state')).toHaveText('Conectado con tu suscripción');

  // Taking it back leaves the account without Claude again.
  await account.getByRole('button', { name: 'Quitar mi Claude' }).click();
  await expect(account.getByText('Sin token de Claude', { exact: false })).toBeVisible();
  await guest.reload();
  await expect(guest.getByTestId('claude-state')).toHaveText('Sin conectar');
  await other.close();
});
