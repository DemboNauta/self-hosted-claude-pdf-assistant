import { expect, test, type Page } from '@playwright/test';
import { login, seedDocument, tinyPdf } from './helpers';

/** Replaces the browser's speech recognition with one the test speaks through. */
async function fakeMicrophone(page: Page) {
  await page.addInitScript(() => {
    type Handler = ((e: unknown) => void) | null;
    const w = window as unknown as Record<string, unknown>;
    class FakeRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      onresult: Handler = null;
      onend: (() => void) | null = null;
      onerror: Handler = null;
      start() {
        w.__rec = this;
      }
      stop() {
        if (w.__rec === this) w.__rec = null;
        this.onend?.();
      }
    }
    w.SpeechRecognition = FakeRecognition;
    // No echo-cancelled microphone: barge-in relies on the text filter (the level gate
    // has its own unit test).
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no microphone'));
    w.__say = (transcript: string, isFinal: boolean) => {
      const rec = w.__rec as FakeRecognition | null;
      rec?.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] });
    };
  });
}

const say = (page: Page, text: string, final = true) =>
  page.evaluate(
    ([t, f]) =>
      (window as unknown as { __say: (t: string, f: boolean) => void }).__say(
        t as string,
        f as boolean,
      ),
    [text, final] as const,
  );

// Voice mode (F-CHAT-09): the microphone stays open, Claude explains out loud, the
// student cuts in with a question and the explanation resumes where it was left.
test('talk to Claude, interrupt it and let it carry on', async ({ page }, info) => {
  await fakeMicrophone(page);
  const spoken: string[] = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/api/tts') && req.method() === 'POST') {
      spoken.push((JSON.parse(req.postData() ?? '{}') as { text: string }).text);
    }
  });
  await login(page);
  const docId = await seedDocument(
    page,
    `Voz ${info.project.name}`,
    tinyPdf([['Tema 1. La fotosintesis.', 'La fotosintesis ocurre en los cloroplastos.']]),
  );
  await page.goto(`/read/${docId}`);
  await expect(page.locator('[data-page="1"]')).toBeVisible();
  const chat = page.locator('section[aria-label="Claude"]');
  if (!(await chat.isVisible())) {
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  }

  await chat.getByTestId('voice-toggle').click();
  const phase = page.getByTestId('voice-phase');
  await expect(phase).toHaveText('Te escucho…');

  // A spoken question: Claude answers out loud, sentence by sentence.
  await say(page, 'Explícame esta página');
  await expect(chat.getByTestId('user-message').last()).toContainText('Explícame esta página');
  await expect(phase).toContainText('Hablando');
  await expect.poll(() => spoken.join(' | ')).toContain('Vamos a verlo con un ejemplo sencillo');

  // Cutting in: it stops, answers the question, then resumes the explanation.
  // (Right after a question, what the microphone hears is still its tail: wait.)
  await page.waitForTimeout(1600);
  await expect(phase).toContainText('Hablando');
  await say(page, 'espera qué es la clorofila', false);
  await expect(phase).toHaveText('Te escucho…');
  await say(page, 'espera qué es la clorofila');
  await expect(chat.getByTestId('assistant-message').last()).toContainText(
    'La clorofila es el pigmento verde',
  );
  await expect
    .poll(() => spoken.join(' | '), { timeout: 20_000 })
    .toContain('Sigo con lo que te estaba contando.');
  await expect
    .poll(() => spoken.at(-1), { timeout: 20_000 })
    .toContain('la planta guarda esa energía en forma de azúcar');
  await expect(phase).toHaveText('Te escucho…', { timeout: 20_000 });

  await page.getByRole('button', { name: 'Salir del modo voz' }).first().click();
  await expect(page.getByTestId('voice-bar')).toHaveCount(0);
});
