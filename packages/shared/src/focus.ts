import { z } from 'zod';

/** Study-timer methods (F-FOCUS-01): classic Pomodoro, fixed presets and a custom one. */
export const STUDY_METHODS = [
  'pomodoro',
  'long-pomodoro',
  'desktime',
  'ultradian',
  'custom',
] as const;
export type StudyMethod = (typeof STUDY_METHODS)[number];

export interface TimerDurations {
  focusMin: number;
  shortBreakMin: number;
  longBreakMin: number;
  /** Focus blocks before a long break; 0 = never a long break. */
  cyclesBeforeLongBreak: number;
}

export const METHOD_PRESETS: Record<Exclude<StudyMethod, 'custom'>, TimerDurations> = {
  pomodoro: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, cyclesBeforeLongBreak: 4 },
  'long-pomodoro': { focusMin: 50, shortBreakMin: 10, longBreakMin: 30, cyclesBeforeLongBreak: 3 },
  desktime: { focusMin: 52, shortBreakMin: 17, longBreakMin: 17, cyclesBeforeLongBreak: 0 },
  ultradian: { focusMin: 90, shortBreakMin: 20, longBreakMin: 20, cyclesBeforeLongBreak: 0 },
};

export interface StudyTimerSettings {
  method: StudyMethod;
  /** Durations used when `method` is "custom". */
  custom: TimerDurations;
  /** Chime when a focus block or a break ends. */
  sound: boolean;
  /** Full-screen break screen over the app while a break runs. */
  breakScreen: boolean;
  /** Start the next focus block by itself when a break ends. */
  autoStartFocus: boolean;
}

export const DEFAULT_STUDY_TIMER: StudyTimerSettings = {
  method: 'pomodoro',
  custom: METHOD_PRESETS.pomodoro,
  sound: true,
  breakScreen: true,
  autoStartFocus: false,
};

/** Durations the timer runs with for the given settings. */
export function timerDurations(s: StudyTimerSettings): TimerDurations {
  return s.method === 'custom' ? s.custom : METHOD_PRESETS[s.method];
}

export const studyTimerSchema = z.object({
  method: z.enum(STUDY_METHODS),
  custom: z.object({
    focusMin: z.number().int().min(1).max(240),
    shortBreakMin: z.number().int().min(1).max(120),
    longBreakMin: z.number().int().min(1).max(120),
    cyclesBeforeLongBreak: z.number().int().min(0).max(12),
  }),
  sound: z.boolean(),
  breakScreen: z.boolean(),
  autoStartFocus: z.boolean(),
});

/** A focus block the timer finished or cut short (F-FOCUS-02). */
export const recordFocusSchema = z.object({
  /** Client-generated id of the block: recording twice (two tabs) is a no-op. */
  id: z.string().regex(/^[\w-]{8,64}$/),
  /** PDF open in the reader when the block ended, if any. */
  documentId: z.string().min(1).max(64).nullable(),
  /** Local day (YYYY-MM-DD) the block ended on. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seconds: z
    .number()
    .int()
    .min(1)
    .max(6 * 3600),
  /** True when the block ran to the end (counts as a pomodoro). */
  completed: z.boolean(),
  method: z.enum(STUDY_METHODS),
});
export type RecordFocus = z.infer<typeof recordFocusSchema>;
