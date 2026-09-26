import type { StudyStats } from '@pdfclaudeassistant/shared';
import type { Db } from '../db/client.js';
import type { LibraryService } from './library.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Statistics (F-REV-04): streak, study time, reviews, retention, progress, concepts. */
export class StatsService {
  constructor(
    private readonly db: Db,
    private readonly library: LibraryService,
  ) {}

  /** `today` is the viewer's local day (YYYY-MM-DD). */
  stats(today: string): StudyStats {
    const c = this.db.$client;
    const perDaySeconds = new Map(
      (
        c.prepare('SELECT day, SUM(seconds) AS s FROM study_sessions GROUP BY day').all() as {
          day: string;
          s: number;
        }[]
      ).map((r) => [r.day, r.s]),
    );
    const perDayReviews = new Map(
      (
        c.prepare('SELECT day, COUNT(*) AS n FROM reviews GROUP BY day').all() as {
          day: string;
          n: number;
        }[]
      ).map((r) => [r.day, r.n]),
    );
    const active = (day: string) =>
      (perDaySeconds.get(day) ?? 0) >= 60 || (perDayReviews.get(day) ?? 0) > 0;

    // Streak: consecutive active days ending today (or yesterday, if today has no activity yet).
    const base = new Date(`${today}T00:00:00Z`);
    let streak = 0;
    for (let i = active(today) ? 0 : 1; ; i++) {
      if (!active(isoDay(new Date(base.getTime() - i * DAY_MS)))) break;
      streak++;
    }

    const days: StudyStats['days'] = [];
    for (let i = 29; i >= 0; i--) {
      const day = isoDay(new Date(base.getTime() - i * DAY_MS));
      days.push({
        day,
        seconds: perDaySeconds.get(day) ?? 0,
        reviews: perDayReviews.get(day) ?? 0,
      });
    }
    const since = days[0]!.day;
    const recent = c
      .prepare('SELECT COUNT(*) AS n, SUM(rating > 1) AS ok FROM reviews WHERE day >= ?')
      .get(since) as { n: number; ok: number | null };

    const secondsByDoc = new Map(
      (
        c
          .prepare(
            'SELECT document_id AS id, SUM(seconds) AS s FROM study_sessions GROUP BY document_id',
          )
          .all() as {
          id: string;
          s: number;
        }[]
      ).map((r) => [r.id, r.s]),
    );
    const tree = this.library.tree();
    const avg = (xs: number[]) =>
      xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
    const subjects = tree.subjects.map((s) => {
      const topics = s.topics.map((t) => ({
        id: t.id,
        name: t.name,
        progressPct: avg(t.documents.map((d) => d.progressPct)),
        documents: t.documents.map((d) => ({
          id: d.id,
          title: d.title,
          progressPct: d.progressPct,
          seconds: secondsByDoc.get(d.id) ?? 0,
        })),
      }));
      const docs = topics.flatMap((t) => t.documents);
      return {
        id: s.id,
        name: s.name,
        color: s.color,
        progressPct: avg(docs.map((d) => d.progressPct)),
        seconds: docs.reduce((n, d) => n + d.seconds, 0),
        topics,
      };
    });

    const now = new Date().toISOString();
    const cards = c
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(due_at <= ?) AS due,
                SUM(json_extract(fsrs_json, '$.stability') >= 21) AS mature
           FROM flashcards WHERE status = 'active'`,
      )
      .get(now) as { total: number; due: number | null; mature: number | null };
    const concepts = c
      .prepare(
        'SELECT COUNT(*) AS total, SUM(mastery < 0.4) AS weak, SUM(mastery >= 0.8) AS mastered, AVG(mastery) AS avg FROM concepts',
      )
      .get() as { total: number; weak: number | null; mastered: number | null; avg: number | null };
    const exams = c
      .prepare('SELECT COUNT(*) AS total, SUM(correct) AS correct FROM exam_results')
      .get() as { total: number; correct: number | null };

    return {
      streakDays: streak,
      studySecondsTotal: [...perDaySeconds.values()].reduce((a, b) => a + b, 0),
      days,
      reviewsTotal: [...perDayReviews.values()].reduce((a, b) => a + b, 0),
      retention: recent.n ? (recent.ok ?? 0) / recent.n : null,
      cards: { total: cards.total, due: cards.due ?? 0, mature: cards.mature ?? 0 },
      subjects,
      concepts: {
        total: concepts.total,
        weak: concepts.weak ?? 0,
        mastered: concepts.mastered ?? 0,
        averageMastery: concepts.avg,
      },
      exams: { total: exams.total, correct: exams.correct ?? 0 },
    };
  }
}
