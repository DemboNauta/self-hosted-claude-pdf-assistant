import type { Diagram } from '@pdfclaudeassistant/shared';
import { Link } from 'react-router';
import { Page } from '../../components/Page';
import { t } from '../../i18n';
import { useAllDiagrams } from './api';
import { DiagramList } from './DiagramList';

/** "Esquemas": every diagram Claude made, grouped by PDF. */
export function DiagramsPage() {
  const { data, isPending } = useAllDiagrams();
  const groups = new Map<string, { title: string; docId: string | null; items: Diagram[] }>();
  for (const d of data ?? []) {
    const key = d.documentId ?? '';
    const group = groups.get(key) ?? {
      title: d.documentTitle ?? t.diagrams.noDocument,
      docId: d.documentId,
      items: [],
    };
    group.items.push(d);
    groups.set(key, group);
  }

  return (
    <Page title={t.diagrams.title}>
      <p className="text-text-muted mb-6 text-sm">{t.diagrams.intro}</p>
      {isPending ? null : groups.size === 0 ? (
        <p className="text-text-muted">{t.diagrams.empty}</p>
      ) : (
        <div className="space-y-8">
          {[...groups.values()].map((g) => (
            <section key={g.docId ?? 'none'} aria-label={g.title} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="truncate text-lg font-medium">{g.title}</h2>
                {g.docId && (
                  <Link
                    to={`/read/${g.docId}`}
                    className="text-text-muted shrink-0 text-sm hover:underline"
                  >
                    {t.diagrams.openPdf}
                  </Link>
                )}
              </div>
              <DiagramList diagrams={g.items} />
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}
