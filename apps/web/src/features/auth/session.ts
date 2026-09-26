import type {
  AcceptInvitation,
  CurrentUser,
  LoginRequest,
  SessionInfo,
} from '@pdfclaudeassistant/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { chatSocket } from '../chat/store';

export const sessionKey = ['session'] as const;

export function useSession() {
  return useQuery({ queryKey: sessionKey, queryFn: () => api<SessionInfo>('/auth/session') });
}

/** The logged-in account (inside the authenticated shell). */
export function useCurrentUser(): CurrentUser | undefined {
  return useSession().data?.user;
}

/** Whether the account can talk to Claude (own token, or the admin's server credentials). */
export const canUseClaude = (user: CurrentUser | undefined) =>
  Boolean(user && (user.hasClaudeToken || user.serverClaude));

/**
 * Starts a session. Everything cached (and the chat socket) belonged to whoever was
 * logged in before, so it is dropped first.
 */
function useStartSession<A>(fn: (args: A) => Promise<SessionInfo>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      chatSocket.close();
      qc.clear();
      qc.setQueryData(sessionKey, data);
    },
  });
}

export function useLogin() {
  return useStartSession((body: LoginRequest) =>
    api<SessionInfo>('/auth/login', { method: 'POST', json: body }),
  );
}

export function useSignup() {
  return useStartSession((body: AcceptInvitation) =>
    api<SessionInfo>('/auth/signup', { method: 'POST', json: body }),
  );
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<SessionInfo>('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      chatSocket.close();
      qc.clear();
      qc.setQueryData(sessionKey, { authenticated: false });
    },
  });
}

/** Keeps the cached session in step after the account changes (profile, token). */
export function useSetCurrentUser() {
  const qc = useQueryClient();
  return (user: CurrentUser) =>
    qc.setQueryData<SessionInfo>(sessionKey, { authenticated: true, user });
}
