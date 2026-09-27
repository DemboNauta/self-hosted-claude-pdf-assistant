import { BookOpen, Brain, Flame, Layers, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Page } from '../../components/Page';
import { t } from '../../i18n';
import { Markdown } from '../chat/Markdown';
import { canUseClaude, useCurrentUser } from '../auth/session';
import { generateBrief, useBrief, useStats } from '../review/api';
import { Last30 } from '../stats/StatsPage';

function MiniTile({
  icon,
  label,
  value,
  detail,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="border-border rounded-xl border px-3 py-2">
      <p className="text-text-muted flex items-center gap-1 text-xs">
        {icon}
        {label}
      </p>
      <p className="font-serif text-lg tabular-nums">{value}</p>
      <p className="text-text-muted text-xs">{detail}</p>
    </div>
  );
}

/** Home: "Repaso de hoy", continue reading and brief stats (F-REV-03, SPEC §4). */
export function HomePage() {
  const brief = useBrief();
  const stats = useStats();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(false);
  const asked = useRef(false);
  const claude = canUseClaude(useCurrentUser());

  const generate = async () => {
    setGenerating(true);
    setError(false);
    try {
      await generateBrief();
    } catch {
      setError(true);
    } finally {
      setGenerating(false);
    }
  };

  // Claude proposes today's review once a day, when the app is opened.
  const data = brief.data;
  const hasContent = Boolean(
    data && (data.dueCount || data.concepts.length || data.continueReading),
  );
  useEffect(() => {
    if (claude && data && !data.text && hasContent && !asked.current) {
      asked.current = true;
      void generate();
    }
  }, [claude, data, hasContent]);

  const todaySeconds = stats.data?.days.at(-1)?.seconds ?? 0;
  const todayReviews = stats.data?.days.at(-1)?.reviews ?? 0;

  return (
    <Page title={t.home.title}>
      <div className="space-y-8">
        <section
          aria-labelledby="today"
          className="border-border bg-surface space-y-4 rounded-2xl border p-5"
        >
          <h2 id="today" className="flex items-center gap-2 font-serif text-xl">
            <Sparkles size={18} aria-hidden />
            {t.home.today}
          </h2>
          {data && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm">
                  <Layers size={14} aria-hidden className="mr-1 inline" />
                  {t.home.cardsDue(data.dueCount)}
                </p>
                {data.dueCount > 0 && (
                  <Link
                    to="/review"
                    className="bg-accent text-accent-contrast rounded-lg px-3 py-1.5 text-sm font-medium"
                  >
                    {t.home.startReview}
                  </Link>
                )}
              </div>
              {data.claudeCards > 0 && (
                <p className="flex items-center gap-1.5 text-sm" data-testid="claude-cards">
                  <Sparkles size={14} aria-hidden className="text-orange-600" />
                  {t.home.claudeCards(data.claudeCards)}
                </p>
              )}
              {data.concepts.length > 0 && (
                <div className="space-y-1">
                  <h3 className="text-text-muted text-xs font-medium tracking-wide uppercase">
                    {t.home.concepts}
                  </h3>
                  <ul className="flex flex-wrap gap-2">
                    {data.concepts.map((c) => (
                      <li key={c.id}>
                        <Link
                          to={
                            c.documentId
                              ? `/read/${c.documentId}${c.page ? `?page=${c.page}` : ''}`
                              : '/memory'
                          }
                          className="bg-surface-muted rounded-full px-2.5 py-1 text-sm"
                        >
                          {c.name} · {Math.round(c.mastery * 100)}%
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {generating ? (
                <p className="text-text-muted text-sm" role="status">
                  {t.home.generating}
                </p>
              ) : data.text ? (
                <div className="space-y-2">
                  <Markdown text={data.text} />
                  <button
                    type="button"
                    onClick={() => void generate()}
                    className="text-text-muted hover:text-text flex items-center gap-1 text-xs"
                  >
                    <RefreshCw size={12} aria-hidden />
                    {t.home.regenerate}
                  </button>
                </div>
              ) : hasContent ? (
                <button type="button" onClick={() => void generate()} className="text-sm underline">
                  {t.home.askClaude}
                </button>
              ) : (
                <p className="text-text-muted text-sm">{t.home.welcome}</p>
              )}
              {error && (
                <p role="alert" className="text-danger text-sm">
                  {t.home.briefError}
                </p>
              )}
            </>
          )}
        </section>

        {data?.continueReading && (
          <section aria-labelledby="continue" className="space-y-2">
            <h2
              id="continue"
              className="text-text-muted text-xs font-medium tracking-wide uppercase"
            >
              {t.home.continueReading}
            </h2>
            <Link
              to={`/read/${data.continueReading.id}`}
              className="border-border hover:bg-surface-muted flex items-center gap-3 rounded-xl border p-3"
            >
              <BookOpen size={20} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{data.continueReading.title}</span>
                <span className="text-text-muted text-sm">
                  {t.home.page(data.continueReading.lastPage, data.continueReading.progressPct)}
                </span>
              </span>
            </Link>
          </section>
        )}

        {stats.data && (
          <section aria-labelledby="stats-brief" className="space-y-3">
            <h2
              id="stats-brief"
              className="text-text-muted flex items-center justify-between text-xs font-medium tracking-wide uppercase"
            >
              {t.home.stats}
              <Link to="/stats" className="normal-case underline">
                {t.home.allStats}
              </Link>
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MiniTile
                icon={<Flame size={14} aria-hidden className="text-orange-600" />}
                label={t.stats.streak}
                value={t.stats.days(stats.data.streakDays)}
                detail={t.home.studiedToday(t.stats.duration(todaySeconds))}
              />
              <MiniTile
                icon={<Layers size={14} aria-hidden />}
                label={t.stats.cards}
                value={t.home.dueShort(stats.data.cards.due)}
                detail={t.home.reviewedToday(todayReviews)}
              />
              <MiniTile
                label={t.stats.retention}
                value={
                  stats.data.retention === null ? '—' : `${Math.round(stats.data.retention * 100)}%`
                }
                detail={t.home.matureCards(stats.data.cards.mature)}
              />
              <MiniTile
                icon={<Brain size={14} aria-hidden />}
                label={t.home.weakConcepts}
                value={String(stats.data.concepts.weak)}
                detail={
                  stats.data.concepts.averageMastery === null
                    ? t.home.noConcepts
                    : t.home.mastery(Math.round(stats.data.concepts.averageMastery * 100))
                }
              />
            </div>
            <Last30 days={stats.data.days} compact />
          </section>
        )}
      </div>
    </Page>
  );
}
