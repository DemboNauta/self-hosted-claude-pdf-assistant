import type { SearchHit } from '@pdfclaudeassistant/shared';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Page } from '../../components/Page';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { useLibrary } from '../library/api';
import { Snippet } from '../reader/SidePanels';

/** Full-text search across the library (F-SRC-01/02). */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const scope = params.get('scope') ?? '';
  const [input, setInput] = useState(q);
  const library = useLibrary();

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (input.trim()) next.set('q', input.trim());
      else next.delete('q');
      if (next.toString() !== params.toString()) setParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [input, params, setParams]);

  const [kind, id] = scope.split(':');
  const results = useQuery({
    queryKey: ['search', q, scope],
    queryFn: () => {
      const s = new URLSearchParams({
        q,
        limit: '200',
        scope: kind === 's' ? 'subject' : kind === 't' ? 'topic' : 'all',
      });
      if (id) s.set('id', id);
      return api<SearchHit[]>(`/search?${s}`);
    },
    enabled: q.length > 0,
  });

  const groups = new Map<string, { title: string; hits: SearchHit[] }>();
  for (const h of results.data ?? []) {
    const g = groups.get(h.docId) ?? { title: h.title, hits: [] };
    g.hits.push(h);
    groups.set(h.docId, g);
  }
  const term = q.split(/\s+/)[0] ?? '';

  return (
    <Page title={t.search.title}>
      <div className="mb-8 flex flex-col gap-3 sm:flex-row">
        <input
          type="search"
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t.search.placeholder}
          aria-label={t.search.title}
          className="border-border bg-surface min-w-0 flex-1 rounded-xl border px-4 py-2.5 text-base"
        />
        <select
          value={scope}
          aria-label={t.search.scope}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set('scope', e.target.value);
            else next.delete('scope');
            setParams(next, { replace: true });
          }}
          className="border-border bg-surface rounded-xl border px-3 py-2.5"
        >
          <option value="">{t.search.everywhere}</option>
          {library.data?.subjects.map((s) => (
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
      </div>

      {results.isFetching && <p className="text-text-muted text-sm">{t.common.loading}</p>}
      {results.data && (
        <p className="text-text-muted mb-4 text-sm" role="status">
          {results.data.length ? t.search.count(results.data.length, groups.size) : t.search.none}
        </p>
      )}
      <div className="space-y-6">
        {[...groups].map(([docId, g]) => (
          <section key={docId} aria-label={g.title} className="space-y-2">
            <h2 className="flex items-center gap-2 font-medium">
              <FileText size={16} aria-hidden />
              <Link to={`/read/${docId}`} className="hover:underline">
                {g.title}
              </Link>
            </h2>
            <ul className="border-border divide-border divide-y rounded-xl border">
              {g.hits.map((h) => (
                <li key={h.page}>
                  <Link
                    to={`/read/${docId}?page=${h.page}&q=${encodeURIComponent(term)}`}
                    className="hover:bg-surface-muted block px-4 py-2.5"
                    data-testid="search-hit"
                  >
                    <span className="text-text-muted text-xs">{t.reader.pageLabel(h.page)}</span>
                    <span className="block text-sm">
                      <Snippet text={h.snippet} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Page>
  );
}
