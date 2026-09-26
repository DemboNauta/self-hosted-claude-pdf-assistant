import type { CurrentUser } from '@pdfclaudeassistant/shared';
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { t } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { useCurrentUser, useSetCurrentUser } from '../auth/session';

const inputClass = 'border-border bg-surface w-full rounded-lg border px-3 py-1.5 text-sm';
const errorText = (err: unknown) =>
  err instanceof ApiError ? (t.account.errors[err.code] ?? t.common.error) : t.common.error;

/** Settings → "Tu cuenta": name, login name and password (multi-user). */
export function AccountSettings() {
  const user = useCurrentUser();
  return user ? <AccountForms user={user} /> : null;
}

function AccountForms({ user }: { user: CurrentUser }) {
  const setUser = useSetCurrentUser();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [username, setUsername] = useState(user.username);
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = { name: useId(), user: useId(), current: useId(), next: useId() };

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setUser(
        await api<CurrentUser>('/account', { method: 'PATCH', json: { displayName, username } }),
      );
      setProfileMsg({ ok: true, text: t.account.saved });
    } catch (err) {
      setProfileMsg({ ok: false, text: errorText(err) });
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/account/password', {
        method: 'POST',
        json: { currentPassword: current, newPassword: next },
      });
      setCurrent('');
      setNext('');
      setPasswordMsg({ ok: true, text: t.account.password.done });
    } catch (err) {
      setPasswordMsg({ ok: false, text: errorText(err) });
    }
  };

  return (
    <section aria-labelledby="account" className="space-y-6">
      <h2 id="account" className="text-lg font-medium">
        {t.account.title}
      </h2>
      {user.role === 'admin' && (
        <Link to="/admin" className="text-accent inline-block text-sm underline">
          {t.account.manageUsers}
        </Link>
      )}
      <form onSubmit={saveProfile} className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={ids.name} className="block text-sm">
            {t.account.displayName}
          </label>
          <input
            id={ids.name}
            required
            maxLength={60}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.user} className="block text-sm">
            {t.account.username}
          </label>
          <input
            id={ids.user}
            required
            autoCapitalize="none"
            spellCheck={false}
            pattern="[A-Za-z0-9._\-]{3,32}"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button type="submit" className="border-border rounded-md border px-3 py-1.5 text-sm">
            {t.account.saveProfile}
          </button>
          {profileMsg && (
            <p role="status" className={profileMsg.ok ? 'text-sm' : 'text-danger text-sm'}>
              {profileMsg.text}
            </p>
          )}
        </div>
      </form>

      <form onSubmit={changePassword} className="space-y-3">
        <h3 className="font-medium">{t.account.password.title}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={ids.current} className="block text-sm">
              {t.account.password.current}
            </label>
            <input
              id={ids.current}
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={ids.next} className="block text-sm">
              {t.account.password.next}
            </label>
            <input
              id={ids.next}
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="border-border rounded-md border px-3 py-1.5 text-sm">
            {t.account.password.submit}
          </button>
          {passwordMsg && (
            <p role="status" className={passwordMsg.ok ? 'text-sm' : 'text-danger text-sm'}>
              {passwordMsg.text}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
