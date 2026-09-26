import { z } from 'zod';

/** Login names: lower-case letters, digits, dot, dash and underscore. */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/);
export const passwordSchema = z.string().min(8).max(1024);

export const loginRequestSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export type UserRole = 'admin' | 'user';

/** The logged-in account, as the web app sees it. */
export interface CurrentUser {
  id: string;
  username: string;
  role: UserRole;
  /** A personal Claude token is saved (its value is never sent back). */
  hasClaudeToken: boolean;
  /** Claude is usable without a personal token (the admin uses the server's credentials). */
  serverClaude: boolean;
}

export interface SessionInfo {
  authenticated: boolean;
  user?: CurrentUser;
}

export const updateProfileSchema = z.object({
  username: usernameSchema.optional(),
});
export type UpdateProfile = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordSchema,
});
export type ChangePassword = z.infer<typeof changePasswordSchema>;

/** `claude setup-token` output: an OAuth token, pasted in Settings. */
export const claudeTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20)
    .max(4096)
    .regex(/^[A-Za-z0-9._~+/=-]+$/),
});

// ---- admin --------------------------------------------------------------

export interface AdminUser {
  id: string;
  username: string;
  role: UserRole;
  hasClaudeToken: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  documentCount: number;
}

export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});
export type CreateUser = z.infer<typeof createUserSchema>;

export const adminUpdateUserSchema = z.object({
  disabled: z.boolean().optional(),
  password: passwordSchema.optional(),
});
export type AdminUpdateUser = z.infer<typeof adminUpdateUserSchema>;

export const INVITATION_TTL_DAYS = 7;

export interface Invitation {
  id: string;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByUsername: string | null;
}

export const createInvitationSchema = z.object({
  note: z.string().trim().max(120).optional(),
});

/** A new invitation: the token is shown once, only its hash is stored. */
export interface CreatedInvitation extends Invitation {
  token: string;
}

/** What the sign-up page shows before the account exists. */
export interface InvitationCheck {
  valid: boolean;
}

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(128),
  username: usernameSchema,
  password: passwordSchema,
});
export type AcceptInvitation = z.infer<typeof acceptInvitationSchema>;
