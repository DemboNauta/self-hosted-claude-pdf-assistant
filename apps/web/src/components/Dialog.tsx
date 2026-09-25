import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { t } from '../i18n';

/**
 * Modal built on the native <dialog> (focus trap, Escape and backdrop for free).
 * Rendered only while open; `onSubmit` runs on the primary button or Enter.
 */
export function Dialog({
  title,
  children,
  submitLabel,
  danger,
  submitDisabled,
  onSubmit,
  onClose,
}: {
  title: string;
  children?: ReactNode;
  submitLabel: string;
  danger?: boolean;
  submitDisabled?: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (submitDisabled) return;
    onSubmit();
    onClose();
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()}
      aria-labelledby="dialog-title"
      className="bg-surface text-text m-auto w-[min(28rem,calc(100%-2rem))] rounded-xl p-0 shadow-xl backdrop:bg-black/40"
    >
      <form onSubmit={submit} className="space-y-5 p-5">
        <h2 id="dialog-title" className="font-serif text-xl">
          {title}
        </h2>
        {children}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="text-text-muted hover:text-text rounded-lg px-3 py-2 text-sm"
          >
            {t.library.cancel}
          </button>
          <button
            type="submit"
            disabled={submitDisabled}
            className={
              danger
                ? 'bg-danger rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:text-black'
                : 'bg-accent text-accent-contrast rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50'
            }
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Single text field dialog (create / rename). */
export function NameDialog({
  title,
  label,
  initial = '',
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      title={title}
      submitLabel={submitLabel}
      onSubmit={() => {
        const name = input.current?.value.trim();
        if (name) onSubmit(name);
      }}
      onClose={onClose}
    >
      <label className="block space-y-2">
        <span className="text-sm font-medium">{label}</span>
        <input
          ref={input}
          defaultValue={initial}
          required
          maxLength={200}
          autoFocus
          className="border-border bg-bg w-full rounded-lg border px-3 py-2 text-base"
        />
      </label>
    </Dialog>
  );
}
