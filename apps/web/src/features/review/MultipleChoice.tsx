import type { Flashcard, ReviewRating } from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { Check, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Markdown } from '../chat/Markdown';

/** How long a right answer may take to count as "Fácil": reading time plus a margin. */
export function fastLimitMs(card: Pick<Flashcard, 'front' | 'back' | 'distractors'>) {
  const chars = card.front.length + card.back.length + (card.distractors ?? []).join('').length;
  return Math.min(12_000, 3_000 + chars * 25);
}

/** The FSRS rating of a multiple-choice answer: wrong = again, right = good, or easy if fast. */
export function ratingFor(correct: boolean, elapsedMs: number, fastMs: number): ReviewRating {
  if (!correct) return 1;
  return elapsedMs <= fastMs ? 4 : 3;
}

/** A stable shuffle per card, so the options do not jump around between renders. */
export function shuffled<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A card answered by choosing among the right answer and three wrong ones. The choice
 * is rated automatically: a right answer moves on by itself, a wrong one shows the
 * right answer until the student continues.
 */
export function MultipleChoice({
  card,
  busy,
  onRate,
}: {
  card: Flashcard;
  busy: boolean;
  onRate: (rating: ReviewRating) => void;
}) {
  const options = useMemo(
    () => shuffled([card.back, ...(card.distractors ?? [])], card.id),
    [card.id, card.back, card.distractors],
  );
  const right = options.indexOf(card.back);
  const [picked, setPicked] = useState<number | null>(null);
  // When the card appeared (set after mounting: render must stay pure).
  const started = useRef(0);
  useEffect(() => {
    started.current = performance.now();
  }, []);
  const rating = useRef<ReviewRating>(1);
  const next = useRef<HTMLButtonElement>(null);
  // The latest callback, so re-renders of the page do not restart the timer below.
  const rate = useRef(onRate);
  useEffect(() => {
    rate.current = onRate;
  });

  const pick = (i: number) => {
    if (picked !== null || busy) return;
    setPicked(i);
    rating.current = ratingFor(i === right, performance.now() - started.current, fastLimitMs(card));
  };

  // A right answer moves on after a short confirmation; a wrong one waits for the student.
  useEffect(() => {
    if (picked === null) return;
    if (picked !== right) {
      next.current?.focus();
      return;
    }
    const timer = setTimeout(() => rate.current(rating.current), 700);
    return () => clearTimeout(timer);
  }, [picked, right]);

  // Keys 1–4 choose; Enter or Space continues after a mistake.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      const n = Number(e.key);
      if (picked === null && n >= 1 && n <= options.length) {
        e.preventDefault();
        pick(n - 1);
      } else if (picked !== null && picked !== right && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onRate(rating.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="space-y-3">
      <ol className="grid gap-2" aria-label={t.review.choices.label}>
        {options.map((text, i) => {
          const isRight = picked !== null && i === right;
          const isWrong = picked === i && i !== right;
          return (
            <li key={i}>
              <button
                type="button"
                // aria-disabled, not disabled: the browser would grey the text out, and
                // the answers must stay readable once chosen.
                aria-disabled={picked !== null || busy}
                onClick={() => pick(i)}
                aria-describedby={isRight || isWrong ? `choice-${i}-result` : undefined}
                className={clsx(
                  'text-text flex w-full items-start gap-3 rounded-xl border-2 px-3 py-2.5 text-left transition-colors',
                  isRight
                    ? 'border-ok bg-ok/10'
                    : isWrong
                      ? 'border-danger bg-danger/10'
                      : picked === null
                        ? 'border-border hover:bg-surface-muted'
                        : 'border-border text-text-muted',
                )}
              >
                <span
                  className="text-text-muted mt-0.5 w-4 shrink-0 text-xs tabular-nums"
                  aria-hidden
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <Markdown text={text} />
                </span>
                {isRight && <Check size={16} className="text-ok mt-0.5 shrink-0" aria-hidden />}
                {isWrong && <X size={16} className="text-danger mt-0.5 shrink-0" aria-hidden />}
                {(isRight || isWrong) && (
                  <span id={`choice-${i}-result`} className="sr-only">
                    {isRight ? t.review.choices.right : t.review.choices.wrong}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="min-h-5 text-sm">
        {picked !== null &&
          (picked === right ? (
            <span className="text-ok">{t.review.choices.correct}</span>
          ) : (
            <span className="text-danger">{t.review.choices.incorrect}</span>
          ))}
      </p>
      {picked !== null && picked !== right && (
        <button
          ref={next}
          type="button"
          disabled={busy}
          onClick={() => onRate(rating.current)}
          className="bg-accent text-accent-contrast w-full rounded-xl px-4 py-3 font-medium disabled:opacity-50"
        >
          {t.review.choices.next}
        </button>
      )}
    </div>
  );
}
