import { BookOpen, Flame, Layers, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Page } from '../../components/Page';
import { t } from '../../i18n';
import { Markdown } from '../chat/Markdown';
import { canUseClaude, useCurrentUser } from '../auth/session';
import { generateBrief, useBrief, useStats } from '../review/api';

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
          <section aria-labelledby="stats-brief" className="space-y-2">
            <h2
              id="stats-brief"
              className="text-text-muted text-xs font-medium tracking-wide uppercase"
            >
              {t.home.stats}
            </h2>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span className="flex items-center gap-1">
                <Flame size={16} aria-hidden className="text-orange-600" />
                {t.home.streak(stats.data.streakDays)}
              </span>
              <span>{t.home.studiedToday(Math.round(todaySeconds / 60))}</span>
              <Link to="/stats" className="underline">
                {t.stats.title}
              </Link>
            </div>
          </section>
        )}
      </div>
    </Page>
  );
}
