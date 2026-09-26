import type { StudyMethod, TimerDurations } from '@pdfclaudeassistant/shared';

export type Phase = 'focus' | 'short' | 'long';
export type TimerStatus = 'idle' | 'running' | 'paused';

/** Study-timer state (F-FOCUS-01). Times are epoch ms so it survives reloads and tab sleep. */
export interface TimerState {
  phase: Phase;
  status: TimerStatus;
  /** When the running phase ends. */
  endsAt: number | null;
  /** Time left while idle or paused. */
  remainingMs: number;
  /** Full length of the current phase. */
  phaseMs: number;
  /** Focus blocks completed since the last long break. */
  cycle: number;
  /** Id of the current focus block, fixed when it first starts (idempotent recording). */
  blockId: string | null;
  method: StudyMethod;
}

/** A focus block to record in the statistics. */
export interface FocusBlock {
  id: string;
  seconds: number;
  completed: boolean;
  method: StudyMethod;
}

/** Blocks cut short under a minute are not recorded. */
const MIN_PARTIAL_MS = 60_000;
/** A phase that ended longer ago than this (tab closed) does not chain into the next one. */
const CHAIN_GRACE_MS = 60_000;

const MIN = 60_000;

export function phaseLength(phase: Phase, d: TimerDurations) {
  return (
    (phase === 'focus' ? d.focusMin : phase === 'short' ? d.shortBreakMin : d.longBreakMin) * MIN
  );
}

export function initialTimer(d: TimerDurations, method: StudyMethod): TimerState {
  const phaseMs = phaseLength('focus', d);
  return {
    phase: 'focus',
    status: 'idle',
    endsAt: null,
    remainingMs: phaseMs,
    phaseMs,
    cycle: 0,
    blockId: null,
    method,
  };
}

export function remainingMs(s: TimerState, now: number) {
  return s.status === 'running' && s.endsAt !== null ? Math.max(0, s.endsAt - now) : s.remainingMs;
}

export function isBreak(phase: Phase) {
  return phase !== 'focus';
}

export function start(s: TimerState, now: number, newId: () => string): TimerState {
  if (s.status === 'running') return s;
  return {
    ...s,
    status: 'running',
    endsAt: now + s.remainingMs,
    blockId: s.phase === 'focus' ? (s.blockId ?? newId()) : null,
  };
}

export function pause(s: TimerState, now: number): TimerState {
  if (s.status !== 'running') return s;
  return { ...s, status: 'paused', endsAt: null, remainingMs: remainingMs(s, now) };
}

/** The part of the current focus block already done, if worth recording. */
function partialBlock(s: TimerState, now: number): FocusBlock | null {
  if (s.phase !== 'focus' || !s.blockId) return null;
  const done = s.phaseMs - remainingMs(s, now);
  return done >= MIN_PARTIAL_MS
    ? { id: s.blockId, seconds: Math.round(done / 1000), completed: false, method: s.method }
    : null;
}

function phaseState(
  s: TimerState,
  phase: Phase,
  d: TimerDurations,
  cycle: number,
  run: { from: number; newId: () => string } | null,
): TimerState {
  const phaseMs = phaseLength(phase, d);
  return {
    ...s,
    phase,
    phaseMs,
    cycle,
    status: run ? 'running' : 'idle',
    endsAt: run ? run.from + phaseMs : null,
    remainingMs: phaseMs,
    blockId: run && phase === 'focus' ? run.newId() : null,
  };
}

/** Break after a focus block: a long one every `cyclesBeforeLongBreak` blocks. */
function breakAfter(cycle: number, d: TimerDurations): Phase {
  return d.cyclesBeforeLongBreak > 0 && cycle >= d.cyclesBeforeLongBreak ? 'long' : 'short';
}

export interface Transition {
  next: TimerState;
  /** Focus block to record, if the transition ended one. */
  recorded: FocusBlock | null;
  /** Phase that just ended by running out (chime, break screen). */
  ended: Phase | null;
}

/**
 * Called on every tick: when the running phase is over, moves to the next one. Breaks start
 * by themselves; the next focus block only with `autoStartFocus`. The next phase is timed
 * from the moment the previous one ended, so a sleeping tab catches up correctly.
 */
export function tick(
  s: TimerState,
  now: number,
  d: TimerDurations,
  autoStartFocus: boolean,
  newId: () => string,
): Transition | null {
  if (s.status !== 'running' || s.endsAt === null || now < s.endsAt) return null;
  const endedAt = s.endsAt;
  const fresh = now - endedAt < CHAIN_GRACE_MS;
  if (s.phase === 'focus') {
    const cycle = s.cycle + 1;
    const phase = breakAfter(cycle, d);
    return {
      next: phaseState(s, phase, d, cycle, { from: endedAt, newId }),
      recorded: s.blockId
        ? {
            id: s.blockId,
            seconds: Math.round(s.phaseMs / 1000),
            completed: true,
            method: s.method,
          }
        : null,
      ended: 'focus',
    };
  }
  const cycle = s.phase === 'long' ? 0 : s.cycle;
  return {
    next: phaseState(
      s,
      'focus',
      d,
      cycle,
      autoStartFocus && fresh ? { from: endedAt, newId } : null,
    ),
    recorded: null,
    ended: s.phase,
  };
}

/** "Saltar": a focus block ends early (recorded as partial) and its break starts; a break ends now. */
export function skip(
  s: TimerState,
  now: number,
  d: TimerDurations,
  newId: () => string,
): Transition {
  if (s.phase === 'focus') {
    return {
      next: phaseState(s, breakAfter(s.cycle + 1, d), d, s.cycle, { from: now, newId }),
      recorded: partialBlock(s, now),
      ended: null,
    };
  }
  const cycle = s.phase === 'long' ? 0 : s.cycle;
  return {
    next: phaseState(s, 'focus', d, cycle, { from: now, newId }),
    recorded: null,
    ended: null,
  };
}

/** "Reiniciar": back to an idle focus block and a new cycle. */
export function reset(s: TimerState, now: number, d: TimerDurations): Transition {
  return {
    next: { ...initialTimer(d, s.method) },
    recorded: partialBlock(s, now),
    ended: null,
  };
}

/** New durations or method from the settings: only an idle phase picks them up right away. */
export function applySettings(s: TimerState, d: TimerDurations, method: StudyMethod): TimerState {
  if (s.status !== 'idle') return { ...s, method };
  const phaseMs = phaseLength(s.phase, d);
  return { ...s, method, phaseMs, remainingMs: phaseMs };
}

export function formatClock(ms: number) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
