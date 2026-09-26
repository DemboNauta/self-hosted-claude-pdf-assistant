import type { Flashcard, LibraryTree } from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { BookOpen, Check, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Page } from '../../components/Page';
import { t } from '../../i18n';
import { Markdown } from '../chat/Markdown';
import { useLibrary } from '../library/api';
import { deleteCard, invalidateReview, rate, updateCard, useQueue, type ReviewFilter } from './api';

function FilterSelect({
  tree,
  value,
  onChange,
}: {
  tree: LibraryTree | undefined;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-text-muted">{t.review.filterLabel}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-border bg-bg rounded-lg border px-2 py-1.5"
      >
        <option value="">{t.review.filterAll}</option>
        {tree?.subjects.map((s) => (
          <optgroup key={s.id} label={s.name}>
            <option value={`s:${s.id}`}>{s.name}</option>
            {s.topics.map((tp) => (
              <option key={tp.id} value={`t:${tp.id}`}>
                · {tp.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function SourceLink({ card }: { card: Flashcard }) {
  if (!card.documentId) return null;
  return (
    <Link
      to={`/read/${card.documentId}${card.page ? `?page=${card.page}` : ''}`}
      className="text-text-muted hover:text-text inline-flex items-center gap-1 text-xs"
    >
      <BookOpen size={12} aria-hidden />
      {card.documentTitle}
      {card.page ? `, p. ${card.page}` : ''}
    </Link>
  );
}

/** Edits a card in place (proposals and the current card). */
function CardEditor({ card, onDone }: { card: Flashcard; onDone: () => void }) {
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void updateCard(card.id, { front, back }).then(onDone);
      }}
      className="space-y-2"
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium">{t.review.front}</span>
        <textarea
          value={front}
          onChange={(e) => setFront(e.target.value)}
          rows={2}
          className="border-border bg-bg w-full rounded-lg border px-2 py-1.5 text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium">{t.review.back}</span>
        <textarea
          value={back}
          onChange={(e) => setBack(e.target.value)}
          rows={3}
          className="border-border bg-bg w-full rounded-lg border px-2 py-1.5 text-sm"
        />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="text-text-muted px-2 py-1 text-sm">
          {t.library.cancel}
        </button>
        <button
          type="submit"
          className="bg-accent text-accent-contrast rounded-lg px-3 py-1 text-sm"
        >
          {t.review.save}
        </button>
      </div>
    </form>
  );
}

function Proposals({ cards }: { cards: Flashcard[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (!cards.length) return null;
  const accept = (ids: string[]) =>
    void Promise.all(ids.map((id) => updateCard(id, { status: 'active' }))).then(invalidateReview);
  return (
    <section
      aria-labelledby="proposals"
      className="border-border mb-10 space-y-3 rounded-xl border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="proposals" className="font-medium">
          {t.review.proposals(cards.length)}
        </h2>
        <button
          type="button"
          onClick={() => accept(cards.map((c) => c.id))}
          className="text-sm font-medium hover:underline"
        >
          {t.review.acceptAll}
        </button>
      </div>
      <ul className="divide-border divide-y">
        {cards.map((c) => (
          <li key={c.id} className="space-y-1 py-3" data-testid="proposal">
            {editing === c.id ? (
              <CardEditor card={c} onDone={() => setEditing(null)} />
            ) : (
              <>
                <p className="text-sm font-medium">{c.front}</p>
                <p className="text-text-muted text-sm">{c.back}</p>
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <SourceLink card={c} />
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => accept([c.id])}
                    className="flex items-center gap-1 text-sm"
                  >
                    <Check size={14} aria-hidden /> {t.review.accept}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(c.id)}
                    aria-label={t.review.edit}
                    className="text-text-muted"
                  >
                    <Pencil size={14} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => void updateCard(c.id, { status: 'rejected' })}
                    className="text-text-muted flex items-center gap-1 text-sm"
                  >
                    <X size={14} aria-hidden /> {t.review.reject}
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Flashcard review with FSRS (F-REV-01/02/05). */
export function ReviewPage() {
  const [params, setParams] = useSearchParams();
  const filterValue = params.get('f') ?? '';
  const filter: ReviewFilter = filterValue.startsWith('s:')
    ? { subjectId: filterValue.slice(2) }
    : filterValue.startsWith('t:')
      ? { topicId: filterValue.slice(2) }
      : {};
  const library = useLibrary();
  const queue = useQueue(filter);
  const [shown, setShown] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const card = queue.data?.due[0];

  const answer = async (rating: 1 | 2 | 3 | 4) => {
    if (!card || busy) return;
    setBusy(true);
    try {
      await rate(card, rating);
      setShown(false);
      await queue.refetch();
      invalidateReview();
    } finally {
      setBusy(false);
    }
  };

  // Space shows the answer, 1–4 rate it (F-UX-03).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      )
        return;
      if (e.key === ' ' && !shown) {
        e.preventDefault();
        setShown(true);
      } else if (shown && ['1', '2', '3', '4'].includes(e.key)) {
        void answer(Number(e.key) as 1 | 2 | 3 | 4);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <Page title={t.review.title}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <FilterSelect
          tree={library.data}
          value={filterValue}
          onChange={(v) => setParams(v ? { f: v } : {})}
        />
        {queue.data && (
          <p className="text-text-muted text-sm">{t.review.due(queue.data.due.length)}</p>
        )}
      </div>

      {queue.data && <Proposals cards={queue.data.proposed} />}

      {queue.isPending && <p className="text-text-muted">{t.common.loading}</p>}
      {queue.data && !card && (
        <p className="text-text-muted">
          {queue.data.total ? t.review.doneToday : t.review.noCards}
        </p>
      )}
      {card && (
        <article
          className="border-border bg-surface space-y-5 rounded-2xl border p-6 shadow-sm"
          data-testid="flashcard"
          aria-live="polite"
        >
          {editing ? (
            <CardEditor
              card={card}
              onDone={() => {
                setEditing(false);
                void queue.refetch();
              }}
            />
          ) : (
            <>
              <div className="text-lg">
                <Markdown text={card.front} />
              </div>
              {shown && (
                <div className="border-border border-t pt-4">
                  <Markdown text={card.back} />
                </div>
              )}
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <SourceLink card={card} />
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setEditing(!editing)}
              aria-label={t.review.edit}
              title={t.review.edit}
              className="text-text-muted hover:text-text"
            >
              <Pencil size={16} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => void deleteCard(card.id)}
              aria-label={t.review.delete}
              title={t.review.delete}
              className="text-text-muted hover:text-danger"
            >
              <Trash2 size={16} aria-hidden />
            </button>
          </div>
          {!editing &&
            (shown ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([1, 2, 3, 4] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    disabled={busy}
                    onClick={() => void answer(r)}
                    className={clsx(
                      'flex flex-col items-center rounded-xl border px-3 py-2 disabled:opacity-50',
                      r === 1 ? 'border-danger/50' : r === 3 ? 'border-text' : 'border-border',
                    )}
                  >
                    <span className="font-medium">{t.review.ratings[r]}</span>
                    {queue.data?.preview && (
                      <span className="text-text-muted text-xs">{queue.data.preview[r]}</span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShown(true)}
                className="bg-accent text-accent-contrast w-full rounded-xl px-4 py-3 font-medium"
              >
                {t.review.showAnswer}
              </button>
            ))}
          <p className="text-text-muted hidden text-center text-xs sm:block">
            {t.review.shortcuts}
          </p>
        </article>
      )}
    </Page>
  );
}
