import type { SessionInfo } from '@pdfclaudeassistant/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export const sessionKey = ['session'] as const;

export function useSession() {
  return useQuery({ queryKey: sessionKey, queryFn: () => api<SessionInfo>('/auth/session') });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) =>
      api<SessionInfo>('/auth/login', { method: 'POST', json: { password } }),
    onSuccess: (data) => qc.setQueryData(sessionKey, data),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<SessionInfo>('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(sessionKey, { authenticated: false });
    },
  });
}
