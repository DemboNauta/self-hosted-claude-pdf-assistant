import clsx from 'clsx';
import { Timer } from 'lucide-react';
import { t } from '../../i18n';
import { formatClock, remainingMs } from './engine';
import { useTimer } from './store';
import { useNow } from './useNow';

/**
 * Shows or hides the floating study timer. `nav` is the sidebar entry (with the time left
 * while it runs hidden); otherwise an icon button for toolbars and page headers.
 */
export function TimerToggle({ nav, className }: { nav?: boolean; className?: string }) {
  const open = useTimer((s) => s.open);
  const timer = useTimer((s) => s.timer);
  const toggleOpen = useTimer((s) => s.toggleOpen);
  const running = timer.status === 'running';
  const now = useNow(running && !open);
  const label = open ? t.timer.close : t.timer.show;

  if (nav) {
    return (
      <button
        type="button"
        onClick={toggleOpen}
        aria-pressed={open}
        className={clsx(
          'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm',
          open ? 'bg-surface-muted font-medium' : 'text-text-muted hover:text-text',
          className,
        )}
      >
        <Timer size={18} aria-hidden />
        <span className="flex-1 text-left">{t.nav.timer}</span>
        {running && !open && (
          <span className="tabular-nums">{formatClock(remainingMs(timer, now))}</span>
        )}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={open}
      onClick={toggleOpen}
      className={clsx(
        'relative rounded-md p-2',
        open
          ? 'bg-surface-muted text-text'
          : 'text-text-muted hover:text-text hover:bg-surface-muted',
        className,
      )}
    >
      <Timer size={18} aria-hidden />
      {running && !open && (
        <span className="bg-accent absolute top-1.5 right-1.5 size-1.5 rounded-full" aria-hidden />
      )}
    </button>
  );
}
