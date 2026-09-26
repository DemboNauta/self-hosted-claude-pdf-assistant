import type { AppSettings, StudyStats } from '@pdfclaudeassistant/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authedApp, seedDocument, tempDataDir } from './helpers.js';

let app: FastifyInstance;
let headers: Record<string, string>;
let docId: string;

const today = new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  ({ app, headers } = await authedApp(tempDataDir('pca-focus-')));
  ({ docId } = await seedDocument(app, headers, [['Derivadas.']]));
});
afterEach(() => app.close());

const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as 'GET', url, headers, ...(payload ? { payload } : {}) });

const block = (over: Record<string, unknown> = {}) => ({
  id: 'block-0001',
  documentId: docId,
  day: today,
  seconds: 1500,
  completed: true,
  method: 'pomodoro',
  ...over,
});

describe('study timer (F-FOCUS-01/02)', () => {
  it('records focus blocks once and shows them in the stats', async () => {
    expect((await inject('POST', '/api/focus-sessions', block())).statusCode).toBe(204);
    // The same block from a second tab is ignored.
    expect((await inject('POST', '/api/focus-sessions', block())).statusCode).toBe(204);
    // A block cut short counts as focused time, not as a pomodoro.
    await inject(
      'POST',
      '/api/focus-sessions',
      block({ id: 'block-0002', seconds: 600, completed: false }),
    );
    // An unknown document is stored without it.
    await inject('POST', '/api/focus-sessions', block({ id: 'block-0003', documentId: 'gone' }));

    const stats = (await inject('GET', `/api/stats?day=${today}`)).json<StudyStats>();
    expect(stats.focus).toEqual({
      pomodorosTotal: 2,
      pomodorosToday: 2,
      focusSecondsTotal: 3600,
    });
    expect(stats.days.at(-1)).toMatchObject({ day: today, pomodoros: 2, focusSeconds: 3600 });
    expect(stats.streakDays).toBe(1);
  });

  it('validates blocks', async () => {
    expect((await inject('POST', '/api/focus-sessions', block({ seconds: 0 }))).statusCode).toBe(
      400,
    );
    expect((await inject('POST', '/api/focus-sessions', block({ method: 'x' }))).statusCode).toBe(
      400,
    );
    expect((await inject('POST', '/api/focus-sessions', block({ id: 'a b' }))).statusCode).toBe(
      400,
    );
  });

  it('keeps the timer settings, with Pomodoro by default', async () => {
    const initial = (await inject('GET', '/api/settings')).json<AppSettings>();
    expect(initial.studyTimer).toMatchObject({
      method: 'pomodoro',
      sound: true,
      breakScreen: true,
    });

    const studyTimer = {
      method: 'custom',
      custom: { focusMin: 40, shortBreakMin: 8, longBreakMin: 20, cyclesBeforeLongBreak: 3 },
      sound: false,
      breakScreen: true,
      autoStartFocus: true,
    };
    const saved = (await inject('PATCH', '/api/settings', { studyTimer })).json<AppSettings>();
    expect(saved.studyTimer).toEqual(studyTimer);
    expect(
      (
        await inject('PATCH', '/api/settings', {
          studyTimer: { ...studyTimer, custom: { ...studyTimer.custom, focusMin: 0 } },
        })
      ).statusCode,
    ).toBe(400);
  });
});
