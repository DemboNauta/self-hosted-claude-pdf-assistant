import type { Concept, MemoryItem, MemoryOverview } from '@pdfclaudeassistant/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Page } from '../../components/Page';
import { t } from '../../i18n';
import { api } from '../../lib/api';

export const memoryKey = ['memory'] as const;

export function useMemory() {
  return useQuery({ queryKey: memoryKey, queryFn: () => api<MemoryOverview>('/memory') });
}

const dateFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' });

function Items({ items }: { items: MemoryItem[] }) {
  return (
    <ul className="space-y-2">
      {items.map((m) => (
        <li key={m.id} className="flex gap-3 text-sm">
          <span className="text-text-muted w-28 shrink-0 text-xs leading-5">
            {t.memory.categories[m.category]}
          </span>
          <span className="min-w-0 flex-1">{m.content}</span>
          <span className="text-text-muted shrink-0 text-xs leading-5">
            {dateFmt.format(new Date(m.updatedAt))}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ConceptList({ concepts }: { concepts: Concept[] }) {
  return (
    <ul className="space-y-3">
      {concepts.map((c) => (
        <li key={c.id} className="space-y-1">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="min-w-0 flex-1 font-medium">{c.name}</span>
            <span className="text-text-muted text-xs tabular-nums">
              {Math.round(c.mastery * 100)}%
            </span>
          </div>
          <div
            role="meter"
            aria-label={t.memory.mastery(c.name)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(c.mastery * 100)}
            className="bg-surface-muted h-1.5 overflow-hidden rounded-full"
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(4, c.mastery * 100)}%`,
                background:
                  c.mastery < 0.4 ? 'var(--danger)' : c.mastery < 0.7 ? 'var(--warn)' : 'var(--ok)',
              }}
            />
          </div>
          <p className="text-text-muted text-xs">
            {t.memory.failed(c.timesFailed)}
            {c.documentId && c.documentTitle && (
              <>
                {' · '}
                <Link
                  to={`/read/${c.documentId}${c.page ? `?page=${c.page}` : ''}`}
                  className="underline"
                >
                  {c.documentTitle}
                  {c.page ? `, p. ${c.page}` : ''}
                </Link>
              </>
            )}
            {c.lastEvidence && ` · ${c.lastEvidence}`}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** "Lo que Claude sabe de ti" (F-MEM-05): read-only view of Claude's memory. */
export function MemoryPage() {
  const { data, isPending } = useMemory();
  const byDoc = new Map<string, MemoryItem[]>();
  for (const m of data?.documents ?? []) {
    const key = m.documentTitle ?? '—';
    byDoc.set(key, [...(byDoc.get(key) ?? []), m]);
  }
  return (
    <Page title={t.memory.title}>
      <p className="text-text-muted -mt-4 mb-8 text-sm">{t.memory.intro}</p>
      {isPending && <p className="text-text-muted">{t.common.loading}</p>}
      {data && (
        <div className="space-y-10">
          <section aria-labelledby="mem-global" className="space-y-3">
            <h2 id="mem-global" className="text-lg font-medium">
              {t.memory.global}
            </h2>
            {data.global.length ? (
              <Items items={data.global} />
            ) : (
              <p className="text-text-muted text-sm">{t.memory.emptyGlobal}</p>
            )}
          </section>
          <section aria-labelledby="mem-concepts" className="space-y-3">
            <h2 id="mem-concepts" className="text-lg font-medium">
              {t.memory.concepts}
            </h2>
            {data.concepts.length ? (
              <ConceptList concepts={data.concepts} />
            ) : (
              <p className="text-text-muted text-sm">{t.memory.emptyConcepts}</p>
            )}
          </section>
          <section aria-labelledby="mem-docs" className="space-y-4">
            <h2 id="mem-docs" className="text-lg font-medium">
              {t.memory.documents}
            </h2>
            {byDoc.size === 0 && (
              <p className="text-text-muted text-sm">{t.memory.emptyDocuments}</p>
            )}
            {[...byDoc].map(([title, items]) => (
              <div key={title} className="space-y-2">
                <h3 className="font-serif">{title}</h3>
                <Items items={items} />
              </div>
            ))}
          </section>
        </div>
      )}
    </Page>
  );
}
