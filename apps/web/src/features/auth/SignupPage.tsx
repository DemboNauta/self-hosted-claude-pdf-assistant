import type { InvitationCheck } from '@pdfclaudeassistant/shared';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { t } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { useSignup } from './session';

const inputClass = 'border-border bg-surface w-full rounded-lg border px-3 py-2.5 text-base';

/** Sign-up through an invitation link created by the admin (`/invite/:token`). */
export function SignupPage() {
  const { token = '' } = useParams();
  const check = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api<InvitationCheck>(`/auth/invitations/${encodeURIComponent(token)}`),
    retry: false,
  });
  const signup = useSignup();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const ids = { user: useId(), pass: useId(), userHelp: useId(), passHelp: useId() };

  if (signup.data?.authenticated) return <Navigate to="/" replace />;
  const used = signup.error instanceof ApiError && signup.error.code === 'invitation_invalid';

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    signup.mutate({ token, username, password });
  };

  const error =
    signup.error instanceof ApiError
      ? signup.error.status === 429
        ? t.auth.tooManyAttempts
        : (t.auth.errors[signup.error.code] ?? t.common.error)
      : signup.error
        ? t.common.error
        : null;

  return (
    <main className="flex min-h-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-sm space-y-8">
        <header className="space-y-2">
          <h1 className="font-serif text-4xl tracking-tight">{t.auth.signup.title}</h1>
          <p className="text-text-muted">{t.auth.signup.subtitle}</p>
        </header>
        {check.isPending ? (
          <p className="text-text-muted">{t.auth.signup.checking}</p>
        ) : !check.data?.valid || used ? (
          <div className="space-y-4">
            <p role="alert">{t.auth.signup.invalid}</p>
            <Link to="/login" className="text-accent underline">
              {t.auth.signup.toLogin}
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-6">
            <div className="space-y-2">
              <label htmlFor={ids.user} className="block text-sm font-medium">
                {t.auth.signup.username}
              </label>
              <input
                id={ids.user}
                autoComplete="username"
                autoFocus
                autoCapitalize="none"
                spellCheck={false}
                required
                pattern="[A-Za-z0-9._\-]{3,32}"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                aria-describedby={ids.userHelp}
                className={inputClass}
              />
              <p id={ids.userHelp} className="text-text-muted text-xs">
                {t.auth.signup.usernameHelp}
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor={ids.pass} className="block text-sm font-medium">
                {t.auth.signup.password}
              </label>
              <input
                id={ids.pass}
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby={ids.passHelp}
                className={inputClass}
              />
              <p id={ids.passHelp} className="text-text-muted text-xs">
                {t.auth.signup.passwordHelp}
              </p>
            </div>
            {error && (
              <p role="alert" className="text-danger text-sm">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={signup.isPending}
              className="bg-accent text-accent-contrast w-full rounded-lg px-4 py-2.5 font-medium disabled:opacity-60"
            >
              {signup.isPending ? t.auth.signup.submitting : t.auth.signup.submit}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
