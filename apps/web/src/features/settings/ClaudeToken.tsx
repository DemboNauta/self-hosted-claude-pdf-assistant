import type { CurrentUser } from '@pdfclaudeassistant/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { useCurrentUser, useSetCurrentUser } from '../auth/session';

/**
 * The user's own Claude token (`claude setup-token`), stored encrypted on the server.
 * The value is never shown again; it can only be replaced or removed.
 */
export function ClaudeToken({ onChange }: { onChange: () => void }) {
  const user = useCurrentUser();
  const setUser = useSetCurrentUser();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(false);
  const inputId = useId();
  if (!user) return null;

  const done = (next: CurrentUser) => {
    setUser(next);
    setToken('');
    setEditing(false);
    void qc.invalidateQueries({ queryKey: ['brief'] });
    onChange();
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(false);
    try {
      done(await api<CurrentUser>('/account/claude-token', { method: 'PUT', json: { token } }));
    } catch {
      setError(true);
    }
  };
  const remove = async () =>
    done(await api<CurrentUser>('/account/claude-token', { method: 'DELETE' }));

  return (
    <div className="space-y-3">
      <h3 className="font-medium">{t.settings.claude.token.title}</h3>
      <p className="text-text-muted text-sm">
        {user.serverClaude ? t.settings.claude.token.adminHelp : t.settings.claude.token.help}
      </p>
      {user.hasClaudeToken && !editing ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span data-testid="claude-token-state">{t.settings.claude.token.saved}</span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="border-border rounded-md border px-3 py-1.5"
          >
            {t.settings.claude.token.replace}
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            className="border-border text-danger rounded-md border px-3 py-1.5"
          >
            {t.settings.claude.token.remove}
          </button>
        </div>
      ) : (
        <form onSubmit={save} className="space-y-2">
          <label htmlFor={inputId} className="block text-sm">
            {t.settings.claude.token.label}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={inputId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="border-border bg-surface min-w-0 flex-1 rounded-lg border px-3 py-1.5 font-mono text-sm"
            />
            <button
              type="submit"
              className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-sm font-medium"
            >
              {t.settings.claude.token.save}
            </button>
          </div>
          {error && (
            <p role="alert" className="text-danger text-sm">
              {t.settings.claude.token.invalid}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
