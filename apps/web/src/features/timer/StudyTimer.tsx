import { timerDurations, type StudyTimerSettings } from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  X,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { t } from '../../i18n';
import { useSettings } from '../annotations/api';
import { useStats } from '../review/api';
import { BreakScreen } from './BreakScreen';
import { formatClock, isBreak, remainingMs } from './engine';
import { TimerOptions } from './TimerOptions';
import { unlockAudio } from './sound';
import { useTimer } from './store';
import { useNow } from './useNow';

const baseTitle = typeof document === 'undefined' ? '' : document.title;
const EDGE = 8;

function clampPosition(x: number, y: number, el: HTMLElement | null) {
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  return {
    x: Math.round(Math.min(Math.max(EDGE, x), Math.max(EDGE, window.innerWidth - w - EDGE))),
    y: Math.round(Math.min(Math.max(EDGE, y), Math.max(EDGE, window.innerHeight - h - EDGE))),
  };
}

/**
 * Study timer (F-FOCUS-01): mounted once in the app shell. Keeps the timer ticking on every
 * page, and shows the floating widget and the break screen.
 */
export function StudyTimerHost() {
  const settings = useSettings().data?.studyTimer;
  const syncSettings = useTimer((s) => s.syncSettings);
  const tick = useTimer((s) => s.tick);
  const open = useTimer((s) => s.open);
  const timer = useTimer((s) => s.timer);
  const running = timer.status === 'running';
  const now = useNow(running);

  useEffect(() => {
    if (settings) syncSettings(settings);
  }, [settings, syncSettings]);

  useEffect(() => {
    tick();
    if (!running) return;
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [running, tick]);

  // After a reload audio stays locked until the user interacts with the page.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
    window.addEventListener('keydown', unlock, { once: true, capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, []);

  // The remaining time in the tab title, visible from other tabs.
  useEffect(() => {
    document.title = running
      ? `${formatClock(remainingMs(timer, now))} · ${t.timer.phase[timer.phase]}`
      : baseTitle;
  }, [running, timer, now]);
  useEffect(() => () => void (document.title = baseTitle), []);

  return (
    <>
      {open && <TimerWidget />}
      <BreakScreen />
    </>
  );
}

function TimerWidget() {
  const timer = useTimer((s) => s.timer);
  const expanded = useTimer((s) => s.expanded);
  const position = useTimer((s) => s.position);
  const { setExpanded, setPosition, setOpen, start, pause, skip, reset } = useTimer.getState();
  const settings = useTimer((s) => s.settings);
  const running = timer.status === 'running';
  const now = useNow(running);
  const left = remainingMs(timer, now);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [live, setLive] = useState<{ x: number; y: number } | null>(null);
  const pos = live ?? position;

  // Keep the widget on screen when it changes size or the window shrinks.
  useLayoutEffect(() => {
    const fit = () => {
      const p = useTimer.getState().position;
      if (!p) return;
      const c = clampPosition(p.x, p.y, ref.current);
      if (c.x !== p.x || c.y !== p.y) setPosition(c);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [expanded, setPosition]);

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button:not([data-grip])')) return;
    const rect = ref.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    setLive(clampPosition(e.clientX - drag.current.dx, e.clientY - drag.current.dy, ref.current));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (live) setPosition(live);
    setLive(null);
  };
  const onGripKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    const rect = ref.current!.getBoundingClientRect();
    setPosition(clampPosition(rect.left + d[0], rect.top + d[1], ref.current));
  };
  const dragProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  };

  const grip = (
    <button
      type="button"
      data-grip
      aria-label={t.timer.move}
      title={t.timer.move}
      onKeyDown={onGripKey}
      className="text-text-muted hover:text-text cursor-grab touch-none rounded p-1 active:cursor-grabbing"
    >
      <GripVertical size={16} aria-hidden />
    </button>
  );
  const onBreak = isBreak(timer.phase);
  const dot = (
    <span
      aria-hidden
      className={clsx('size-2 shrink-0 rounded-full', onBreak ? 'bg-ok' : 'bg-accent')}
    />
  );
  const primary =
    timer.status === 'running'
      ? { label: t.timer.pause, icon: Pause, onClick: pause }
      : {
          label: timer.status === 'paused' ? t.timer.resume : t.timer.start,
          icon: Play,
          onClick: start,
        };

  return (
    <section
      ref={ref}
      aria-label={t.timer.title}
      data-testid="study-timer"
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      className={clsx(
        'border-border bg-surface text-text fixed z-[45] rounded-xl border shadow-lg',
        !pos && 'right-4 bottom-20 lg:bottom-4',
        expanded ? 'w-72' : 'w-auto',
      )}
    >
      {expanded ? (
        <>
          <header
            {...dragProps}
            className="border-border flex cursor-grab touch-none items-center gap-1 border-b py-1 pr-1 pl-1 select-none"
          >
            {grip}
            <h2 className="flex-1 text-sm font-medium">{t.timer.title}</h2>
            <button
              type="button"
              aria-label={t.timer.collapse}
              title={t.timer.collapse}
              onClick={() => setExpanded(false)}
              className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5"
            >
              <ChevronDown size={16} aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t.timer.close}
              title={t.timer.close}
              onClick={() => setOpen(false)}
              className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5"
            >
              <X size={16} aria-hidden />
            </button>
          </header>
          <div className="space-y-4 p-4">
            <div className="space-y-1 text-center">
              <p className="text-text-muted flex items-center justify-center gap-2 text-sm">
                {dot}
                <span data-testid="timer-phase">{t.timer.phase[timer.phase]}</span>
                {timer.status === 'paused' && <span>· {t.timer.paused}</span>}
              </p>
              <p
                className="font-serif text-5xl tabular-nums"
                role="timer"
                aria-live="off"
                data-testid="timer-clock"
              >
                {formatClock(left)}
              </p>
              <div className="bg-surface-muted h-1 overflow-hidden rounded-full" aria-hidden>
                <div
                  className={clsx('h-full', onBreak ? 'bg-ok' : 'bg-accent')}
                  style={{ width: `${(1 - left / timer.phaseMs) * 100}%` }}
                />
              </div>
              <CycleInfo settings={settings} cycle={timer.cycle} />
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={primary.onClick}
                className="bg-accent text-accent-contrast flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium"
              >
                <primary.icon size={16} aria-hidden />
                {primary.label}
              </button>
              <button
                type="button"
                onClick={skip}
                aria-label={onBreak ? t.timer.skipBreak : t.timer.skipFocus}
                title={onBreak ? t.timer.skipBreak : t.timer.skipFocus}
                className="border-border hover:bg-surface-muted rounded-lg border p-2"
              >
                <SkipForward size={16} aria-hidden />
              </button>
              <button
                type="button"
                onClick={reset}
                aria-label={t.timer.reset}
                title={t.timer.reset}
                className="border-border hover:bg-surface-muted rounded-lg border p-2"
              >
                <RotateCcw size={16} aria-hidden />
              </button>
            </div>
            <TimerOptions />
          </div>
        </>
      ) : (
        <div
          {...dragProps}
          className="flex cursor-grab touch-none items-center gap-1 p-1 select-none"
        >
          {grip}
          {dot}
          <span className="px-1 font-medium tabular-nums" role="timer" data-testid="timer-clock">
            {formatClock(left)}
          </span>
          <button
            type="button"
            onClick={primary.onClick}
            aria-label={primary.label}
            title={primary.label}
            className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5"
          >
            <primary.icon size={16} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t.timer.expand}
            title={t.timer.expand}
            onClick={() => setExpanded(true)}
            className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5"
          >
            <ChevronUp size={16} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t.timer.close}
            title={t.timer.close}
            onClick={() => setOpen(false)}
            className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      )}
    </section>
  );
}

function CycleInfo({ settings, cycle }: { settings: StudyTimerSettings; cycle: number }) {
  const total = timerDurations(settings).cyclesBeforeLongBreak;
  const today = useStats().data?.focus.pomodorosToday ?? 0;
  return (
    <div className="text-text-muted space-y-1 pt-1 text-xs">
      {total > 0 && (
        <div className="flex items-center justify-center gap-2">
          <span className="flex gap-1" aria-hidden>
            {Array.from({ length: total }, (_, i) => (
              <span
                key={i}
                className={clsx('size-1.5 rounded-full', i < cycle ? 'bg-text' : 'bg-border')}
              />
            ))}
          </span>
          <span>{t.timer.cycle(cycle, total)}</span>
        </div>
      )}
      <p>{t.timer.today(today)}</p>
    </div>
  );
}
