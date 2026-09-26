import { Coffee } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { formatClock, isBreak, remainingMs } from './engine';
import { useTimer } from './store';
import { useNow } from './useNow';

/**
 * Break screen (F-FOCUS-03): covers the app while a break runs, with a tip and the time
 * left; when the break ends it asks whether to start the next block. Optional in the options.
 */
export function BreakScreen() {
  const timer = useTimer((s) => s.timer);
  const enabled = useTimer((s) => s.settings.breakScreen);
  const hidden = useTimer((s) => s.screenHidden);
  const breakOver = useTimer((s) => s.breakOver);
  const onBreak = isBreak(timer.phase) && timer.status === 'running' && !hidden;
  if (!enabled || (!onBreak && !breakOver)) return null;
  return onBreak ? <OnBreak key={timer.endsAt} /> : <BreakOver />;
}

function Overlay({
  title,
  children,
  onEscape,
}: {
  title: string;
  children: ReactNode;
  onEscape: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onEscape();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEscape]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="break-title"
      className="bg-bg/95 fixed inset-0 z-[60] flex items-center justify-center p-6 backdrop-blur-sm"
    >
      <div className="max-w-md space-y-6 text-center">
        <Coffee size={32} className="text-text-muted mx-auto" aria-hidden />
        <h2 id="break-title" className="font-serif text-3xl">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

function OnBreak() {
  const timer = useTimer((s) => s.timer);
  const { skip, hideScreen } = useTimer.getState();
  const now = useNow(true);
  const [tip] = useState(
    () => t.timer.breakTips[Math.floor(Math.random() * t.timer.breakTips.length)]!,
  );
  const phase = timer.phase === 'long' ? 'long' : 'short';
  return (
    <Overlay title={t.timer.breakScreenTitle[phase]} onEscape={hideScreen}>
      <p className="font-serif text-7xl tabular-nums" role="timer" data-testid="break-clock">
        {formatClock(remainingMs(timer, now))}
      </p>
      <p className="text-text-muted text-lg">{tip}</p>
      <div className="flex justify-center gap-3">
        <button
          type="button"
          onClick={hideScreen}
          className="border-border hover:bg-surface-muted rounded-lg border px-4 py-2 text-sm"
        >
          {t.timer.hideScreen}
        </button>
        <button
          type="button"
          onClick={skip}
          className="bg-accent text-accent-contrast rounded-lg px-4 py-2 text-sm font-medium"
        >
          {t.timer.skipBreak}
        </button>
      </div>
    </Overlay>
  );
}

function BreakOver() {
  const { start, dismissBreakOver } = useTimer.getState();
  return (
    <Overlay title={t.timer.breakOverTitle} onEscape={dismissBreakOver}>
      <p className="text-text-muted text-lg">{t.timer.breakOverText}</p>
      <div className="flex justify-center gap-3">
        <button
          type="button"
          onClick={start}
          className="bg-accent text-accent-contrast rounded-lg px-4 py-2 text-sm font-medium"
        >
          {t.timer.startNext}
        </button>
        <button
          type="button"
          onClick={dismissBreakOver}
          className="border-border hover:bg-surface-muted rounded-lg border px-4 py-2 text-sm"
        >
          {t.timer.later}
        </button>
      </div>
    </Overlay>
  );
}
