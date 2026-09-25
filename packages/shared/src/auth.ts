import { z } from 'zod';

export const loginRequestSchema = z.object({
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface SessionInfo {
  authenticated: boolean;
}
