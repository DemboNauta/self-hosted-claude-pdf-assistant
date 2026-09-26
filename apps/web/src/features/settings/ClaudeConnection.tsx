import type { ClaudeStatus } from '@pdfclaudeassistant/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { useCurrentUser } from '../auth/session';
import { ClaudeToken } from './ClaudeToken';

const statusKey = ['claude-status'] as const;

const STATE_COLOR: Record<ClaudeStatus['state'], string> = {
  connected: 'bg-ok',
  auth_expired: 'bg-danger',
  rate_limited: 'bg-warn',
  error: 'bg-danger',
  not_configured: 'bg-warn',
};

/** Settings → "Conexión con Claude" (SPEC §6.3). */
export function ClaudeConnection() {
  const qc = useQueryClient();
  const user = useCurrentUser();
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => api<ClaudeStatus>('/claude/status'),
    staleTime: 5 * 60 * 1000,
  });
  const refresh = () =>
    qc.fetchQuery({
      queryKey: statusKey,
      queryFn: () => api<ClaudeStatus>('/claude/status?refresh=1'),
      staleTime: 0,
    });
  const s = status.data;
  const busy = status.isFetching;

  return (
    <section aria-labelledby="claude-connection" className="space-y-4">
      <h2 id="claude-connection" className="text-lg font-medium">
        {t.settings.claude.title}
      </h2>
      <p className="text-text-muted text-sm">{t.settings.claude.description}</p>

      <div className="border-border bg-surface space-y-3 rounded-lg border p-4" aria-live="polite">
        {status.isPending ? (
          <p className="text-text-muted text-sm">{t.settings.claude.checking}</p>
        ) : status.isError || !s ? (
          <p className="text-danger text-sm">{t.common.error}</p>
        ) : (
          <>
            <p className="flex items-center gap-2 font-medium" data-testid="claude-state">
              <span className={clsx('size-2.5 rounded-full', STATE_COLOR[s.state])} aria-hidden />
              {t.settings.claude.states[s.state]}
            </p>
            <dl className="text-text-muted grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt>{t.settings.claude.method}</dt>
              <dd>{t.settings.claude.methods[s.authMethod]}</dd>
              {s.model && (
                <>
                  <dt>{t.settings.claude.model}</dt>
                  <dd>{s.model}</dd>
                </>
              )}
              <dt>{t.settings.claude.lastChecked}</dt>
              <dd>{new Date(s.checkedAt).toLocaleString('es')}</dd>
            </dl>
            {s.state === 'auth_expired' && user?.hasClaudeToken && (
              <p className="bg-surface-muted rounded-md p-3 text-sm">
                {t.settings.claude.renewOwnToken}
              </p>
            )}
            {s.state === 'auth_expired' && !user?.hasClaudeToken && (
              <div className="bg-surface-muted space-y-2 rounded-md p-3 text-sm">
                <p className="font-medium">{t.settings.claude.renewTitle}</p>
                <p>{t.settings.claude.renewToken}</p>
                <p>{t.settings.claude.renewLogin}</p>
              </div>
            )}
            {s.state === 'rate_limited' && (
              <p className="bg-surface-muted rounded-md p-3 text-sm">
                {t.settings.claude.rateLimitedHelp}
              </p>
            )}
          </>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="border-border rounded-md border px-3 py-1.5 text-sm disabled:opacity-60"
        >
          {busy ? t.settings.claude.checking : t.settings.claude.check}
        </button>
      </div>
      <ClaudeToken onChange={() => void refresh()} />
    </section>
  );
}
