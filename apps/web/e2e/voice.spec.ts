import { expect, test, type Page } from '@playwright/test';
import { login, seedDocument, tinyPdf } from './helpers';

/**
 * Replaces the browser's speech recognition with one the test speaks through. With
 * `phoneLike`, a second (echo-cancelled) microphone opens but the recognition refuses
 * to start while it is open, as some Android phones do.
 */
async function fakeMicrophone(page: Page, phoneLike = false) {
  await page.addInitScript((phone: boolean) => {
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
        if (w.__micOpen) {
          setTimeout(() => {
            this.onerror?.({ error: 'not-allowed' });
            this.onend?.();
          }, 50);
          return;
        }
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
    navigator.mediaDevices.getUserMedia = async () => {
      if (!phone) throw new Error('no microphone');
      const stream = new AudioContext().createMediaStreamDestination().stream;
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          w.__micOpen = false;
          stop();
        };
      }
      w.__micOpen = true;
      return stream;
    };
    w.__say = (transcript: string, isFinal: boolean) => {
      const rec = w.__rec as FakeRecognition | null;
      rec?.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] });
    };
  }, phoneLike);
}

const say = async (page: Page, text: string, final = true) => {
  // The recognition restarts between sessions: speak once it is listening.
  await page.waitForFunction(() => (window as unknown as { __rec: unknown }).__rec);
  await page.evaluate(
    ([t, f]) =>
      (window as unknown as { __say: (t: string, f: boolean) => void }).__say(
        t as string,
        f as boolean,
      ),
    [text, final] as const,
  );
};

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
    .poll(() => spoken.join(' | '), { timeout: 20_000 })
    .toContain('la planta guarda esa energía en forma de azúcar');

  // Podcast style: it carries on by itself until the topic is done.
  await expect(chat.getByTestId('voice-continue').first()).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => spoken.join(' | '), { timeout: 20_000 })
    .toContain('Y con esto hemos terminado el tema.');
  await expect(chat.getByTestId('assistant-message').last()).not.toContainText('voice-end');
  await expect(phase).toHaveText('Te escucho…', { timeout: 20_000 });

  await page.getByRole('button', { name: 'Salir del modo voz' }).first().click();
  await expect(page.getByTestId('voice-bar')).toHaveCount(0);
});

// A phone that cannot share the microphone: voice mode gives up the echo-cancelled
// one by itself and keeps listening; ?vozdebug=1 shows why on screen.
test('voice mode recovers on a phone that cannot share the microphone', async ({ page }, info) => {
  await fakeMicrophone(page, true);
  await login(page);
  const docId = await seedDocument(
    page,
    `Voz móvil ${info.project.name}`,
    tinyPdf([['Tema 1. La fotosintesis.', 'La fotosintesis ocurre en los cloroplastos.']]),
  );
  await page.goto(`/read/${docId}?vozdebug=1`);
  await expect(page.locator('[data-page="1"]')).toBeVisible();
  const chat = page.locator('section[aria-label="Claude"]');
  if (!(await chat.isVisible())) {
    await page.getByRole('button', { name: 'Abrir chat con Claude' }).click();
  }
  await chat.getByTestId('voice-toggle').click();
  await expect(page.getByTestId('voice-debug')).toContainText('micro: plain');
  await expect(page.getByTestId('voice-bar').getByRole('alert')).toHaveCount(0);

  await say(page, 'Explícame esta página');
  await expect(chat.getByTestId('user-message').last()).toContainText('Explícame esta página');
  await page.getByRole('button', { name: 'Salir del modo voz' }).first().click();
  await page.goto('/?vozdebug=0');
});
