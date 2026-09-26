import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

const localDay = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

async function pomodoros(page: Page): Promise<number> {
  const stats = await (await page.request.get(`/api/stats?day=${localDay()}`)).json();
  return stats.focus.pomodorosTotal as number;
}

// Study timer (F-FOCUS-01..03): Pomodoro focus → break screen → next block, a movable
// floating widget that survives reloads, and completed blocks in the statistics.
test('study timer runs a pomodoro with a break and records it', async ({ page }, info) => {
  await page.clock.install();
  await login(page);
  const before = await pomodoros(page);

  await page
    .getByRole('button', { name: /^Temporizador/ })
    .locator('visible=true')
    .first()
    .click();
  const widget = page.getByTestId('study-timer');
  await expect(widget.getByTestId('timer-clock')).toHaveText('25:00');
  await widget.getByRole('button', { name: 'Empezar' }).click();
  await page.clock.runFor(60_000);
  await expect(widget.getByTestId('timer-clock')).toHaveText('24:00');

  // The widget can be moved out of the way (keyboard on every device, drag with a mouse).
  const box = (await widget.boundingBox())!;
  await widget.getByRole('button', { name: /^Mover temporizador/ }).press('ArrowUp');
  await expect.poll(async () => (await widget.boundingBox())!.y).toBeLessThan(box.y);
  if (info.project.name === 'desktop') {
    const grip = (await widget.getByRole('button', { name: /^Mover temporizador/ }).boundingBox())!;
    await page.mouse.move(grip.x + 5, grip.y + 5);
    await page.mouse.down();
    await page.mouse.move(200, 150, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await widget.boundingBox())!.x).toBeLessThan(260);
  }

  // It keeps running across a reload (real time passes while the page loads).
  await page.reload();
  await expect(widget.getByTestId('timer-clock')).toHaveText(/^2[34]:\d\d$/);

  await page.clock.fastForward(24 * 60_000);
  const breakScreen = page.getByRole('dialog', { name: 'Hora de descansar' });
  await expect(breakScreen).toBeVisible();
  await expect(breakScreen.getByTestId('break-clock')).toHaveText(/^0[45]:\d\d$/);
  await expect.poll(() => pomodoros(page)).toBe(before + 1);

  await breakScreen.getByRole('button', { name: 'Ocultar' }).click();
  await expect(breakScreen).toBeHidden();
  await expect(widget.getByTestId('timer-phase')).toHaveText('Descanso corto');

  await page.clock.fastForward(5 * 60_000);
  const over = page.getByRole('dialog', { name: 'Se acabó el descanso' });
  await expect(over).toBeVisible();
  await over.getByRole('button', { name: 'Empezar bloque' }).click();
  await expect(widget.getByTestId('timer-phase')).toHaveText('Foco');
  await expect(widget.getByRole('button', { name: 'Pausar' })).toBeVisible();

  await widget.getByRole('button', { name: 'Reiniciar' }).click();
  await page.goto('/stats');
  await expect(page.getByText('Pomodoros', { exact: true })).toBeVisible();
});
