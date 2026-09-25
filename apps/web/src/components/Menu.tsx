import clsx from 'clsx';
import { MoreHorizontal } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface MenuAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** Small "⋯" popover menu with keyboard support (arrows, Escape). */
export function Menu({
  label,
  actions,
  className,
}: {
  label: string;
  actions: MenuAction[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    root.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={root} className={clsx('relative', className)} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-1.5"
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open && (
        <ul
          id={id}
          role="menu"
          className="border-border bg-surface absolute right-0 z-30 mt-1 min-w-44 rounded-lg border py-1 shadow-lg"
        >
          {actions.map((a) => (
            <li key={a.label} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  a.onSelect();
                }}
                className={clsx(
                  'hover:bg-surface-muted focus:bg-surface-muted w-full px-3 py-2 text-left text-sm outline-none',
                  a.danger && 'text-danger',
                )}
              >
                {a.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
