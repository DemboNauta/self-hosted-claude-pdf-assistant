import {
  DEFAULT_STUDY_TIMER,
  timerDurations,
  type StudyTimerSettings,
} from '@pdfclaudeassistant/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../../lib/api';
import { queryClient } from '../../lib/queryClient';
import { localDay } from '../review/api';
import * as engine from './engine';
import { chime, unlockAudio } from './sound';

const STORAGE_KEY = 'pdfclaudeassistant-timer';

const newId = () => crypto.randomUUID();

/** PDF open in the reader, credited with the focus block. */
function currentDocument() {
  return /^\/read\/([^/]+)/.exec(window.location.pathname)?.[1] ?? null;
}

function record(block: engine.FocusBlock | null) {
  if (!block) return;
  void api('/focus-sessions', {
    method: 'POST',
    json: { ...block, documentId: currentDocument(), day: localDay() },
  })
    .then(() => queryClient.invalidateQueries({ queryKey: ['stats'] }))
    .catch(() => undefined);
}

interface TimerStore {
  timer: engine.TimerState;
  /** Latest settings from the server, mirrored here so the ticker works on any page. */
  settings: StudyTimerSettings;
  /** Floating widget shown. */
  open: boolean;
  expanded: boolean;
  /** Top-left corner of the widget in px; null = default corner. */
  position: { x: number; y: number } | null;
  /** Break screen hidden by the user for the current break. */
  screenHidden: boolean;
  /** A break ended and the next block waits for the user (break screen prompt). */
  breakOver: boolean;

  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setExpanded: (expanded: boolean) => void;
  setPosition: (position: { x: number; y: number } | null) => void;
  syncSettings: (settings: StudyTimerSettings) => void;
  start: () => void;
  pause: () => void;
  skip: () => void;
  reset: () => void;
  hideScreen: () => void;
  dismissBreakOver: () => void;
  /** Advances the timer when the running phase is over (called every tick). */
  tick: () => void;
}

export const useTimer = create<TimerStore>()(
  persist(
    (set, get) => {
      const durations = () => timerDurations(get().settings);
      const apply = (t: engine.Transition) => {
        record(t.recorded);
        set({ timer: t.next, screenHidden: false, breakOver: false });
      };
      return {
        timer: engine.initialTimer(timerDurations(DEFAULT_STUDY_TIMER), DEFAULT_STUDY_TIMER.method),
        settings: DEFAULT_STUDY_TIMER,
        open: false,
        expanded: true,
        position: null,
        screenHidden: false,
        breakOver: false,

        setOpen: (open) => set({ open }),
        toggleOpen: () => set({ open: !get().open, expanded: true }),
        setExpanded: (expanded) => set({ expanded }),
        setPosition: (position) => set({ position }),
        syncSettings: (settings) =>
          set({
            settings,
            timer: engine.applySettings(get().timer, timerDurations(settings), settings.method),
          }),
        start: () => {
          unlockAudio();
          set({
            timer: engine.start(get().timer, Date.now(), newId),
            breakOver: false,
            screenHidden: false,
          });
        },
        pause: () => set({ timer: engine.pause(get().timer, Date.now()) }),
        skip: () => {
          unlockAudio();
          apply(engine.skip(get().timer, Date.now(), durations(), newId));
        },
        reset: () => apply(engine.reset(get().timer, Date.now(), durations())),
        hideScreen: () => set({ screenHidden: true }),
        dismissBreakOver: () => set({ breakOver: false }),
        tick: () => {
          const { settings } = get();
          const t = engine.tick(
            get().timer,
            Date.now(),
            durations(),
            settings.autoStartFocus,
            newId,
          );
          if (!t) return;
          record(t.recorded);
          if (settings.sound) chime(t.ended === 'focus' ? 'break' : 'focus');
          set({
            timer: t.next,
            screenHidden: false,
            breakOver: t.ended !== 'focus' && t.next.status === 'idle',
          });
        },
      };
    },
    {
      name: STORAGE_KEY,
      partialize: ({ timer, settings, open, expanded, position, screenHidden, breakOver }) => ({
        timer,
        settings,
        open,
        expanded,
        position,
        screenHidden,
        breakOver,
      }),
    },
  ),
);

// Other tabs share the same timer: pick up their changes.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) void useTimer.persist.rehydrate();
  });
}
