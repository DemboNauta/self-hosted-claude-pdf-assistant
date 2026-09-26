import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api';
import { useLogin, useSession } from './session';

export function LoginPage() {
  const session = useSession();
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  if (session.data?.authenticated) return <Navigate to="/" replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ username, password });
  };

  const error =
    login.error instanceof ApiError
      ? login.error.status === 429
        ? t.auth.tooManyAttempts
        : t.auth.invalidCredentials
      : login.error
        ? t.common.error
        : null;

  return (
    <main className="flex min-h-full items-center justify-center px-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-8">
        <header className="space-y-2">
          <h1 className="font-serif text-4xl tracking-tight">{t.appName}</h1>
          <p className="text-text-muted">{t.auth.subtitle}</p>
        </header>
        <div className="space-y-2">
          <label htmlFor="username" className="block text-sm font-medium">
            {t.auth.username}
          </label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="border-border bg-surface w-full rounded-lg border px-3 py-2.5 text-base"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="password" className="block text-sm font-medium">
            {t.auth.password}
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="border-border bg-surface w-full rounded-lg border px-3 py-2.5 text-base"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
          />
          {error && (
            <p id="login-error" role="alert" className="text-danger text-sm">
              {error}
            </p>
          )}
        </div>
        <button
          type="submit"
          disabled={login.isPending}
          className="bg-accent text-accent-contrast w-full rounded-lg px-4 py-2.5 font-medium disabled:opacity-60"
        >
          {login.isPending ? t.auth.submitting : t.auth.submit}
        </button>
      </form>
    </main>
  );
}
