import type { StudyStats } from '@pdfclaudeassistant/shared';
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

/** Minutes studied per day, last 30 days (bars; reviews in the tooltip). */
function Last30({ days }: { days: StudyStats['days'] }) {
  const max = Math.max(1, ...days.map((d) => d.seconds));
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium">{t.stats.last30}</figcaption>
      <div className="flex h-32 items-end gap-[3px]" role="img" aria-label={t.stats.last30}>
        {days.map((d) => (
          <div
            key={d.day}
            title={`${dayFmt.format(new Date(`${d.day}T00:00:00Z`))}: ${Math.round(d.seconds / 60)} ${t.stats.minutes}, ${d.reviews} ${t.stats.reviews.toLowerCase()}`}
            className="bg-text/80 min-h-[2px] flex-1 rounded-t-sm"
            style={{ height: `${(d.seconds / max) * 100}%`, opacity: d.seconds ? 1 : 0.15 }}
          />
        ))}
      </div>
      <div className="text-text-muted flex justify-between text-xs">
        <span>{dayFmt.format(new Date(`${days[0]!.day}T00:00:00Z`))}</span>
        <span>{dayFmt.format(new Date(`${days.at(-1)!.day}T00:00:00Z`))}</span>
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
          <div className="grid gap-3 sm:grid-cols-3">
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
