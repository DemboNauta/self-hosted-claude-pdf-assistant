import type { LibraryTree } from '@pdfclaudeassistant/shared';
import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api';
import { generateCards } from './api';

const COUNTS = [5, 10, 20] as const;

/**
 * "Crear tarjetas con Claude" in the review screen: the student picks subjects, topics
 * or PDFs and Claude writes new cards from the pages already read there.
 */
export function GenerateCards({
  tree,
  onDone,
}: {
  tree: LibraryTree | undefined;
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border-border hover:bg-surface-muted flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm"
      >
        <Sparkles size={14} aria-hidden />
        {t.review.generate.open}
      </button>
      {open && (
        <GenerateDialog
          tree={tree}
          onClose={(message) => {
            setOpen(false);
            if (message) onDone(message);
          }}
        />
      )}
    </>
  );
}

function GenerateDialog({
  tree,
  onClose,
}: {
  tree: LibraryTree | undefined;
  onClose: (message?: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [count, setCount] = useState<number>(10);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const readDocs = (ids: { id: string; progressPct: number }[]) =>
    ids.filter((d) => d.progressPct > 0).map((d) => d.id);
  const toggle = (ids: string[], on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const submit = async () => {
    setWorking(true);
    setError(null);
    try {
      const created = await generateCards([...chosen], count);
      ref.current?.close();
      onClose(t.review.generate.done(created.length));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? t.review.generate.nothingRead
          : t.review.generate.failed,
      );
    } finally {
      setWorking(false);
    }
  };

  /** A checkbox for a group of documents: checked, unchecked or partly checked. */
  const groupBox = (ids: string[], label: string) => {
    const n = ids.filter((id) => chosen.has(id)).length;
    return (
      <input
        type="checkbox"
        aria-label={label}
        disabled={!ids.length || working}
        checked={ids.length > 0 && n === ids.length}
        ref={(el) => {
          if (el) el.indeterminate = n > 0 && n < ids.length;
        }}
        onChange={(e) => toggle(ids, e.target.checked)}
        className="accent-accent size-4"
      />
    );
  };

  return (
    <dialog
      ref={ref}
      onClose={() => onClose()}
      onClick={(e) => e.target === ref.current && !working && ref.current.close()}
      aria-labelledby="generate-title"
      className="bg-surface text-text m-auto flex max-h-[85vh] w-[min(34rem,calc(100%-2rem))] flex-col rounded-xl p-0 shadow-xl backdrop:bg-black/40"
    >
      <header className="border-border flex items-center gap-2 border-b px-4 py-3">
        <Sparkles size={16} aria-hidden />
        <h2 id="generate-title" className="text-sm font-medium">
          {t.review.generate.title}
        </h2>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        <p className="text-text-muted">{t.review.generate.intro}</p>
        <ul className="space-y-2">
          {tree?.subjects.map((s) => {
            const subjectDocs = readDocs(s.topics.flatMap((tp) => tp.documents));
            return (
              <li key={s.id}>
                <label className="flex items-center gap-2 font-medium">
                  {groupBox(subjectDocs, s.name)}
                  {s.name}
                </label>
                <ul className="mt-1 space-y-1 pl-6">
                  {s.topics.map((tp) => (
                    <li key={tp.id}>
                      <label className="flex items-center gap-2">
                        {groupBox(readDocs(tp.documents), tp.name)}
                        {tp.name}
                      </label>
                      <ul className="mt-1 space-y-1 pl-6">
                        {tp.documents.map((d) => (
                          <li key={d.id}>
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                disabled={d.progressPct === 0 || working}
                                checked={chosen.has(d.id)}
                                onChange={(e) => toggle([d.id], e.target.checked)}
                                className="accent-accent size-4"
                              />
                              <span className="min-w-0 flex-1 truncate">{d.title}</span>
                              <span className="text-text-muted text-xs tabular-nums">
                                {d.progressPct === 0
                                  ? t.review.generate.unread
                                  : t.review.generate.read(d.progressPct)}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
        {chosen.size === 0 && (
          <p className="text-text-muted text-xs">{t.review.generate.nothingChosen}</p>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {working && (
          <p role="status" className="text-text-muted">
            {t.review.generate.working}
          </p>
        )}
      </div>
      <footer className="border-border flex flex-wrap items-center gap-2 border-t px-4 py-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-text-muted">{t.review.generate.count}</span>
          <select
            value={count}
            disabled={working}
            onChange={(e) => setCount(Number(e.target.value))}
            className="border-border bg-bg rounded-lg border px-2 py-1"
          >
            {COUNTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="flex-1" />
        <button
          type="button"
          disabled={working}
          onClick={() => ref.current?.close()}
          className="text-text-muted hover:text-text rounded-lg px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {t.review.generate.cancel}
        </button>
        <button
          type="button"
          disabled={working}
          onClick={() => void submit()}
          className="bg-accent text-accent-contrast rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {t.review.generate.submit}
        </button>
      </footer>
    </dialog>
  );
}
