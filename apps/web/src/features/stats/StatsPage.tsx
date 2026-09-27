import type { StudyStats } from '@pdfclaudeassistant/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { Page } from '../../components/Page';
import { t } from '../../i18n';
import { useStats } from '../review/api';

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="border-border rounded-xl border p-4">
      <p className="text-text-muted text-xs">{label}</p>
      <p className="font-serif text-2xl tabular-nums">{value}</p>
      {detail && <p className="text-text-muted text-xs">{detail}</p>}
    </div>
  );
}

const dayFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDayFmt = new Intl.DateTimeFormat('es', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** One day of the chart in words: "martes, 23 de septiembre · 1 h 5 min · 12 tarjetas…". */
function dayDetail(d: StudyStats['days'][number]) {
  const parts = [t.stats.studied(d.seconds)];
  if (d.reviews) parts.push(t.stats.reviewedCards(d.reviews));
  if (d.pomodoros) parts.push(t.stats.pomodoroCount(d.pomodoros));
  return parts;
}

/**
 * Time studied per day, last 30 days. Hovering, focusing or tapping a bar shows that
 * day's time, cards reviewed and pomodoros; the latest day is shown by default.
 */
export function Last30({ days, compact = false }: { days: StudyStats['days']; compact?: boolean }) {
  const [selected, setSelected] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.seconds));
  const total = days.reduce((n, d) => n + d.seconds, 0);
  const active = days.filter((d) => d.seconds > 0).length;
  const shown = selected ?? days.length - 1;
  const day = days[shown];
  return (
    <figure className="space-y-2">
      {!compact && (
        <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
          <span className="font-medium">{t.stats.last30}</span>
          <span className="text-text-muted text-xs">
            {t.stats.summary30(t.stats.duration(total), active)}
          </span>
        </figcaption>
      )}
      <p className="min-h-10 text-sm" aria-live="polite" data-testid="chart-detail">
        {day && (
          <>
            <span className="font-medium first-letter:uppercase">
              {selected === null ? t.stats.today : longDayFmt.format(asDate(day.day))}
            </span>
            <span className="text-text-muted block text-xs">{dayDetail(day).join(' · ')}</span>
          </>
        )}
      </p>
      <div
        className={`flex items-end gap-[3px] ${compact ? 'h-16' : 'h-32'}`}
        role="group"
        aria-label={t.stats.last30}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setSelected(null)}
      >
        {days.map((d, i) => (
          <button
            key={d.day}
            type="button"
            aria-label={`${longDayFmt.format(asDate(d.day))}: ${dayDetail(d).join(', ')}`}
            aria-pressed={i === shown}
            onPointerEnter={() => setSelected(i)}
            onFocus={() => setSelected(i)}
            onClick={() => setSelected(i)}
            className="group relative flex h-full flex-1 items-end focus-visible:outline-none"
          >
            <span
              className={`block w-full min-h-[2px] rounded-t-sm transition-colors ${
                i === shown ? 'bg-accent' : 'bg-text/70 group-hover:bg-text'
              } group-focus-visible:ring-accent group-focus-visible:ring-2`}
              style={{ height: `${(d.seconds / max) * 100}%`, opacity: d.seconds ? 1 : 0.2 }}
            />
          </button>
        ))}
      </div>
      <div className="text-text-muted flex justify-between text-xs">
        <span>{dayFmt.format(asDate(days[0]!.day))}</span>
        <span>{t.stats.max(t.stats.duration(max))}</span>
        <span>{dayFmt.format(asDate(days.at(-1)!.day))}</span>
      </div>
    </figure>
  );
}

function Bar({ pct, color }: { pct: number; color?: string }) {
  return (
    <div className="bg-surface-muted h-1.5 flex-1 overflow-hidden rounded-full">
      <div
        className="h-full rounded-full"
        style={{ width: `${pct}%`, background: color ?? 'var(--text)' }}
      />
    </div>
  );
}

/** Statistics (F-REV-04). */
export function StatsPage() {
  const { data } = useStats();
  return (
    <Page title={t.stats.title}>
      {!data ? (
        <p className="text-text-muted">{t.common.loading}</p>
      ) : (
        <div className="space-y-10">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label={t.stats.streak} value={t.stats.days(data.streakDays)} />
            <Tile label={t.stats.studyTime} value={t.stats.duration(data.studySecondsTotal)} />
            <Tile label={t.stats.reviews} value={String(data.reviewsTotal)} />
            <Tile
              label={t.stats.retention}
              value={data.retention === null ? '—' : `${Math.round(data.retention * 100)}%`}
            />
          </div>
          <Last30 days={data.days} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Tile
              label={t.stats.pomodoros}
              value={String(data.focus.pomodorosTotal)}
              detail={t.stats.pomodorosDetail(
                data.focus.pomodorosToday,
                data.focus.focusSecondsTotal,
                t.stats.duration,
              )}
            />
            <Tile
              label={t.stats.cards}
              value={String(data.cards.total)}
              detail={t.stats.cardsDetail(data.cards.total, data.cards.due, data.cards.mature)}
            />
            <Tile
              label={t.stats.concepts}
              value={
                data.concepts.averageMastery === null
                  ? '—'
                  : `${Math.round(data.concepts.averageMastery * 100)}%`
              }
              detail={t.stats.conceptsDetail(
                data.concepts.total,
                data.concepts.weak,
                data.concepts.mastered,
              )}
            />
            <Tile
              label={t.stats.exams}
              value={String(data.exams.total)}
              detail={t.stats.examsDetail(data.exams.total, data.exams.correct)}
            />
          </div>
          <section aria-labelledby="progress" className="space-y-4">
            <h2 id="progress" className="text-lg font-medium">
              {t.stats.progress}
            </h2>
            {data.subjects.length === 0 && (
              <p className="text-text-muted text-sm">{t.stats.empty}</p>
            )}
            {data.subjects.map((s) => (
              <details key={s.id} className="group space-y-2" open={data.subjects.length === 1}>
                <summary className="flex cursor-pointer items-center gap-3">
                  <span
                    className="size-2.5 rounded-full"
                    style={{ background: s.color }}
                    aria-hidden
                  />
                  <span className="w-40 truncate text-sm font-medium sm:w-56">{s.name}</span>
                  <Bar pct={s.progressPct} color={s.color} />
                  <span className="text-text-muted w-24 text-right text-xs tabular-nums">
                    {s.progressPct}% · {t.stats.duration(s.seconds)}
                  </span>
                </summary>
                <ul className="space-y-1 pl-6">
                  {s.topics.flatMap((tp) =>
                    tp.documents.map((d) => (
                      <li key={d.id} className="flex items-center gap-3 text-sm">
                        <Link
                          to={`/read/${d.id}`}
                          className="w-40 truncate hover:underline sm:w-52"
                        >
                          {d.title}
                        </Link>
                        <Bar pct={d.progressPct} />
                        <span className="text-text-muted w-24 text-right text-xs tabular-nums">
                          {d.progressPct}% · {t.stats.duration(d.seconds)}
                        </span>
                      </li>
                    )),
                  )}
                </ul>
              </details>
            ))}
          </section>
        </div>
      )}
    </Page>
  );
}
