import type { AdminUser, CreatedInvitation, Invitation } from '@pdfclaudeassistant/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { Page } from '../../components/Page';
import { t } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { useCurrentUser } from '../auth/session';

const usersKey = ['admin', 'users'] as const;
const invitationsKey = ['admin', 'invitations'] as const;
const inputClass = 'border-border bg-surface w-full rounded-lg border px-3 py-1.5 text-sm';
const buttonClass = 'border-border hover:bg-surface-muted rounded-md border px-2.5 py-1 text-sm';
const errorText = (err: unknown) =>
  err instanceof ApiError ? (t.admin.errors[err.code] ?? t.common.error) : t.common.error;
const date = (iso: string) => new Date(iso).toLocaleDateString('es');

/** Accounts and invitation links; only the admin reaches it (multi-user). */
export function AdminPage() {
  const me = useCurrentUser();
  if (me && me.role !== 'admin') return <Navigate to="/" replace />;
  return (
    <Page title={t.admin.title}>
      <div className="space-y-12">
        <p className="text-text-muted text-sm">{t.admin.intro}</p>
        <Users myId={me?.id} />
        <CreateUser />
        <Invitations />
      </div>
    </Page>
  );
}

function Users({ myId }: { myId?: string }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: usersKey, queryFn: () => api<AdminUser[]>('/admin/users') });
  const [message, setMessage] = useState<string | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [password, setPassword] = useState('');
  const passwordId = useId();

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      setMessage(done ?? null);
    } catch (err) {
      setMessage(errorText(err));
    }
    void qc.invalidateQueries({ queryKey: usersKey });
  };
  const patch = (u: AdminUser, json: Record<string, unknown>, done?: string) =>
    run(() => api(`/admin/users/${u.id}`, { method: 'PATCH', json }), done);

  return (
    <section aria-labelledby="accounts" className="space-y-4">
      <h2 id="accounts" className="text-lg font-medium">
        {t.admin.users}
      </h2>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <ul className="divide-border border-border divide-y rounded-lg border">
        {users.data?.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {u.displayName} <span className="text-text-muted font-normal">@{u.username}</span>
                {u.id === myId && <span className="text-text-muted"> · {t.admin.you}</span>}
                {u.role === 'admin' && (
                  <span className="text-text-muted"> · {t.admin.adminRole}</span>
                )}
                {u.disabled && <span className="text-danger"> · {t.admin.disabled}</span>}
              </p>
              <p className="text-text-muted text-xs">
                {t.admin.documents(u.documentCount)} ·{' '}
                {u.hasClaudeToken || u.role === 'admin' ? t.admin.claudeYes : t.admin.claudeNo} ·{' '}
                {u.lastLoginAt ? t.admin.lastLogin(date(u.lastLoginAt)) : t.admin.neverLoggedIn}
              </p>
            </div>
            {u.role !== 'admin' && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => void patch(u, { disabled: !u.disabled })}
                >
                  {u.disabled ? t.admin.enable : t.admin.disable}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => {
                    setPassword('');
                    setResetting(u);
                  }}
                >
                  {t.admin.resetPassword}
                </button>
                <button
                  type="button"
                  className={`${buttonClass} text-danger`}
                  onClick={() => {
                    if (window.confirm(t.admin.deleteConfirm(u.displayName))) {
                      void run(() => api(`/admin/users/${u.id}`, { method: 'DELETE' }));
                    }
                  }}
                >
                  {t.admin.delete}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {resetting && (
        <Dialog
          title={t.admin.resetPassword}
          submitLabel={t.admin.resetPassword}
          submitDisabled={password.length < 8}
          onSubmit={() => void patch(resetting, { password }, t.admin.resetDone)}
          onClose={() => setResetting(null)}
        >
          <label htmlFor={passwordId} className="block text-sm">
            {t.admin.resetPasswordPrompt(resetting.displayName)}
          </label>
          <input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            autoFocus
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </Dialog>
      )}
    </section>
  );
}

function CreateUser() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ displayName: '', username: '', password: '' });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = { name: useId(), user: useId(), pass: useId() };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const u = await api<AdminUser>('/admin/users', { method: 'POST', json: form });
      setMessage({ ok: true, text: t.admin.create.done(u.username) });
      setForm({ displayName: '', username: '', password: '' });
      void qc.invalidateQueries({ queryKey: usersKey });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  };
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value }),
    required: true,
    className: inputClass,
  });

  return (
    <section aria-labelledby="create-user" className="space-y-4">
      <h2 id="create-user" className="text-lg font-medium">
        {t.admin.create.title}
      </h2>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label htmlFor={ids.name} className="block text-sm">
            {t.admin.create.displayName}
          </label>
          <input id={ids.name} maxLength={60} {...field('displayName')} />
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.user} className="block text-sm">
            {t.admin.create.username}
          </label>
          <input
            id={ids.user}
            autoCapitalize="none"
            spellCheck={false}
            pattern="[A-Za-z0-9._\-]{3,32}"
            {...field('username')}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.pass} className="block text-sm">
            {t.admin.create.password}
          </label>
          <input
            id={ids.pass}
            type="password"
            autoComplete="new-password"
            minLength={8}
            {...field('password')}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
          <button
            type="submit"
            className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-sm font-medium"
          >
            {t.admin.create.submit}
          </button>
          {message && (
            <p role="status" className={message.ok ? 'text-sm' : 'text-danger text-sm'}>
              {message.text}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

function Invitations() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: invitationsKey,
    queryFn: () => api<Invitation[]>('/admin/invitations'),
  });
  const [note, setNote] = useState('');
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const noteId = useId();
  const link = created ? `${location.origin}/invite/${created.token}` : '';

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const inv = await api<CreatedInvitation>('/admin/invitations', {
      method: 'POST',
      json: note.trim() ? { note: note.trim() } : {},
    });
    setCreated(inv);
    setCopied(false);
    setNote('');
    void qc.invalidateQueries({ queryKey: invitationsKey });
  };
  const copy = async () => {
    await navigator.clipboard.writeText(link).catch(() => {});
    setCopied(true);
  };
  const revoke = async (id: string) => {
    await api(`/admin/invitations/${id}`, { method: 'DELETE' });
    if (created?.id === id) setCreated(null);
    void qc.invalidateQueries({ queryKey: invitationsKey });
  };

  return (
    <section aria-labelledby="invitations" className="space-y-4">
      <h2 id="invitations" className="text-lg font-medium">
        {t.admin.invitations.title}
      </h2>
      <p className="text-text-muted text-sm">{t.admin.invitations.help}</p>
      <form onSubmit={create} className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1 space-y-1">
          <label htmlFor={noteId} className="block text-sm">
            {t.admin.invitations.note}
          </label>
          <input
            id={noteId}
            maxLength={120}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={inputClass}
          />
        </div>
        <button
          type="submit"
          className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-sm font-medium"
        >
          {t.admin.invitations.create}
        </button>
      </form>
      {created && (
        <div className="bg-surface-muted space-y-2 rounded-lg p-3" role="status">
          <p className="text-sm">{t.admin.invitations.created}</p>
          <div className="flex flex-wrap gap-2">
            <input
              readOnly
              value={link}
              aria-label={t.admin.invitations.copy}
              onFocus={(e) => e.target.select()}
              data-testid="invitation-link"
              className={`${inputClass} min-w-0 flex-1 font-mono`}
            />
            <button type="button" className={buttonClass} onClick={() => void copy()}>
              {copied ? t.admin.invitations.copied : t.admin.invitations.copy}
            </button>
          </div>
        </div>
      )}
      {list.data?.length === 0 ? (
        <p className="text-text-muted text-sm">{t.admin.invitations.empty}</p>
      ) : (
        <ul className="divide-border border-border divide-y rounded-lg border">
          {list.data?.map((inv) => {
            const expired = !inv.usedAt && new Date(inv.expiresAt) < new Date();
            return (
              <li key={inv.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p>{inv.note || date(inv.createdAt)}</p>
                  <p className="text-text-muted text-xs">
                    {inv.usedAt
                      ? t.admin.invitations.usedBy(inv.usedByUsername ?? '—')
                      : expired
                        ? t.admin.invitations.expired
                        : t.admin.invitations.pending(date(inv.expiresAt))}
                  </p>
                </div>
                {!inv.usedAt && (
                  <button type="button" className={buttonClass} onClick={() => void revoke(inv.id)}>
                    {t.admin.invitations.revoke}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
