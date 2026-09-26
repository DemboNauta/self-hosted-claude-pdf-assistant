import { useEffect, useState } from 'react';

/** No input for this long pauses the clock (the reader probably left). */
const IDLE_MS = 2 * 60 * 1000;

const localDay = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Active-time counter: runs while the tab is visible and the reader interacts. */
class ReadingTimer {
  private seconds = 0;
  private lastActivity = Date.now();

  activity = () => {
    this.lastActivity = Date.now();
  };

  tick = () => {
    if (document.visibilityState === 'visible' && Date.now() - this.lastActivity < IDLE_MS) {
      this.seconds++;
    }
  };

  pending() {
    return this.seconds;
  }

  /** Seconds counted since the last call, with the local day they belong to. */
  take(): { seconds?: number; day?: string } {
    const seconds = Math.min(3600, this.seconds);
    this.seconds = 0;
    return seconds > 0 ? { seconds, day: localDay() } : {};
  }
}

const EVENTS = ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;

/** Reading-time statistics (F-VIS-05). */
export function useReadingTimer() {
  const [timer] = useState(() => new ReadingTimer());
  useEffect(() => {
    EVENTS.forEach((e) =>
      window.addEventListener(e, timer.activity, { passive: true, capture: true }),
    );
    const id = setInterval(timer.tick, 1000);
    return () => {
      clearInterval(id);
      EVENTS.forEach((e) => window.removeEventListener(e, timer.activity, { capture: true }));
    };
  }, [timer]);
  return timer;
}
