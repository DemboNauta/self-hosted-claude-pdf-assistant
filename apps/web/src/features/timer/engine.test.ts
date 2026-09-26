import { METHOD_PRESETS } from '@pdfclaudeassistant/shared';
import { describe, expect, it } from 'vitest';
import {
  applySettings,
  formatClock,
  initialTimer,
  pause,
  remainingMs,
  reset,
  skip,
  start,
  tick,
  type TimerState,
} from './engine';

const d = METHOD_PRESETS.pomodoro;
const MIN = 60_000;
let n = 0;
const newId = () => `block-${++n}`;

/** Runs the timer until the current phase ends and returns the transition. */
function finish(s: TimerState, autoStartFocus = false) {
  return tick(s, s.endsAt!, d, autoStartFocus, newId)!;
}

describe('study timer engine', () => {
  it('runs focus → short break, with a long break every 4 blocks', () => {
    let s = start(initialTimer(d, 'pomodoro'), 0, newId);
    expect(remainingMs(s, 10 * MIN)).toBe(15 * MIN);
    expect(tick(s, 24 * MIN, d, false, newId)).toBeNull();

    const phases: string[] = [];
    const recorded: number[] = [];
    for (let i = 0; i < 4; i++) {
      const focusEnd = finish(s);
      recorded.push(focusEnd.recorded!.seconds);
      expect(focusEnd.recorded!.completed).toBe(true);
      phases.push(focusEnd.next.phase);
      // The break starts by itself, timed from the end of the block.
      expect(focusEnd.next.status).toBe('running');
      expect(focusEnd.next.endsAt! - s.endsAt!).toBe(focusEnd.next.phaseMs);
      const breakEnd = finish(focusEnd.next);
      expect(breakEnd.next).toMatchObject({ phase: 'focus', status: 'idle' });
      s = start(breakEnd.next, breakEnd.next.endsAt ?? s.endsAt!, newId);
    }
    expect(phases).toEqual(['short', 'short', 'short', 'long']);
    expect(recorded).toEqual([1500, 1500, 1500, 1500]);
    expect(s.cycle).toBe(0);
  });

  it('chains the next block only when asked and the break just ended', () => {
    const brk = finish(start(initialTimer(d, 'pomodoro'), 0, newId)).next;
    expect(finish(brk, true).next).toMatchObject({ phase: 'focus', status: 'running' });
    // The tab slept through the end of the break: wait for the user instead.
    expect(tick(brk, brk.endsAt! + 10 * MIN, d, true, newId)!.next.status).toBe('idle');
  });

  it('pauses, skips and resets, recording cut-short blocks of a minute or more', () => {
    let s = start(initialTimer(d, 'pomodoro'), 0, newId);
    s = pause(s, 10 * MIN);
    expect(s).toMatchObject({ status: 'paused', remainingMs: 15 * MIN });
    s = start(s, 20 * MIN, newId);
    expect(s.endsAt).toBe(35 * MIN);

    const skipped = skip(s, 25 * MIN, d, newId);
    expect(skipped.recorded).toMatchObject({ id: s.blockId, seconds: 900, completed: false });
    expect(skipped.next).toMatchObject({ phase: 'short', status: 'running', cycle: 0 });

    const quick = start(initialTimer(d, 'pomodoro'), 0, newId);
    expect(reset(quick, 30_000, d).recorded).toBeNull();
    expect(reset(quick, 5 * MIN, d)).toMatchObject({
      recorded: { seconds: 300, completed: false },
      next: { phase: 'focus', status: 'idle', remainingMs: 25 * MIN },
    });
  });

  it('keeps the block id across pauses so a block is recorded once', () => {
    const s = start(initialTimer(d, 'pomodoro'), 0, newId);
    const resumed = start(pause(s, MIN), 2 * MIN, newId);
    expect(resumed.blockId).toBe(s.blockId);
  });

  it('applies new durations only while idle', () => {
    const idle = initialTimer(d, 'pomodoro');
    expect(applySettings(idle, METHOD_PRESETS.ultradian, 'ultradian').remainingMs).toBe(90 * MIN);
    const running = start(idle, 0, newId);
    expect(applySettings(running, METHOD_PRESETS.ultradian, 'ultradian').endsAt).toBe(25 * MIN);
  });

  it('formats the clock', () => {
    expect(formatClock(25 * MIN)).toBe('25:00');
    expect(formatClock(59_001)).toBe('01:00');
    expect(formatClock(90 * MIN)).toBe('1:30:00');
  });
});
