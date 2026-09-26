import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hash, verify } from '@node-rs/argon2';
import {
  INVITATION_TTL_DAYS,
  type AcceptInvitation,
  type AdminUpdateUser,
  type AdminUser,
  type CreatedInvitation,
  type CreateUser,
  type CurrentUser,
  type Invitation,
  type UpdateProfile,
} from '@pdfclaudeassistant/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { SessionStore } from '../auth/sessions.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { documents, invitations, settings, users } from '../db/schema.js';
import { HttpError, notFound } from './errors.js';
import { newId } from './ids.js';
import { SecretBox, sha256 } from './secrets.js';

/** The account migration 0012 created for the pre-existing data: the server owner. */
export const OWNER_ID = 'owner';
/** Server setting remembering which APP_PASSWORD_HASH was last given to the admin. */
const ADMIN_HASH_KEY = 'admin_password_env';

type UserRow = typeof users.$inferSelect;

/** Keeps a failed login for an unknown name as slow as one with a wrong password. */
let dummyHash: Promise<string> | null = null;

function isUniqueViolation(err: unknown) {
  return (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** Accounts, profiles, personal Claude tokens and invitations (multi-user). */
export class UserService {
  private readonly box: SecretBox;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
  ) {
    this.box = new SecretBox(config.sessionSecret);
  }

  /**
   * Gives the admin the password in APP_PASSWORD_HASH on first boot and whenever that
   * variable changes (the deploy script's -SetPassword); a password changed in the app
   * stays until then.
   */
  syncAdminPassword() {
    const applied = this.db.select().from(settings).where(eq(settings.key, ADMIN_HASH_KEY)).get();
    const owner = this.row(OWNER_ID);
    if (!owner) throw new Error('The admin account is missing (migration 0012).');
    if (applied?.value === JSON.stringify(this.config.passwordHash) && owner.passwordHash) return;
    this.db.transaction((tx) => {
      tx.update(users)
        .set({ passwordHash: this.config.passwordHash })
        .where(eq(users.id, OWNER_ID))
        .run();
      const value = JSON.stringify(this.config.passwordHash);
      tx.insert(settings)
        .values({ key: ADMIN_HASH_KEY, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
    });
  }

  /** The account for a name and password, or null (disabled accounts cannot log in). */
  async authenticate(username: string, password: string): Promise<UserRow | null> {
    const row = this.db.select().from(users).where(eq(users.username, username)).get();
    if (!row) {
      dummyHash ??= hash('not a real password');
      await verify(await dummyHash, password).catch(() => false);
      return null;
    }
    const ok = await verify(row.passwordHash, password).catch(() => false);
    if (!ok || row.disabledAt) return null;
    this.db
      .update(users)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(users.id, row.id))
      .run();
    return row;
  }

  current(id: string): CurrentUser {
    const row = this.row(id);
    if (!row) throw notFound();
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      hasClaudeToken: row.claudeTokenEnc !== null,
      serverClaude: row.id === OWNER_ID,
    };
  }

  // ---- own account --------------------------------------------------------

  updateProfile(id: string, patch: UpdateProfile): CurrentUser {
    if (Object.keys(patch).length) {
      try {
        this.db.update(users).set(patch).where(eq(users.id, id)).run();
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, 'username_taken');
        throw err;
      }
    }
    return this.current(id);
  }

  /** Changes the password and logs out every other session of the account. */
  async changePassword(id: string, current: string, next: string, keepToken?: string) {
    const row = this.row(id);
    if (!row) throw notFound();
    if (!(await verify(row.passwordHash, current).catch(() => false))) {
      throw new HttpError(403, 'wrong_password');
    }
    this.db
      .update(users)
      .set({ passwordHash: await hash(next) })
      .where(eq(users.id, id))
      .run();
    this.sessions.revokeAllFor(id, keepToken);
  }

  setClaudeToken(id: string, token: string | null) {
    this.db
      .update(users)
      .set({ claudeTokenEnc: token === null ? null : this.box.seal(token) })
      .where(eq(users.id, id))
      .run();
  }

  /** The user's own Claude token, decrypted; null if none (or unreadable). */
  claudeToken(id: string): string | null {
    const enc = this.row(id)?.claudeTokenEnc;
    return enc ? this.box.open(enc) : null;
  }

  // ---- admin --------------------------------------------------------------

  list(): AdminUser[] {
    const counts = new Map(
      this.db
        .select({ userId: documents.userId, n: sql<number>`count(*)` })
        .from(documents)
        .where(isNull(documents.deletedAt))
        .groupBy(documents.userId)
        .all()
        .map((r) => [r.userId, r.n]),
    );
    return this.db
      .select()
      .from(users)
      .orderBy(users.createdAt)
      .all()
      .map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        hasClaudeToken: u.claudeTokenEnc !== null,
        disabled: u.disabledAt !== null,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        documentCount: counts.get(u.id) ?? 0,
      }));
  }

  async create(input: CreateUser): Promise<AdminUser> {
    const id = newId();
    try {
      this.db
        .insert(users)
        .values({
          id,
          username: input.username,
          displayName: input.displayName,
          passwordHash: await hash(input.password),
          role: 'user',
        })
        .run();
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'username_taken');
      throw err;
    }
    return this.list().find((u) => u.id === id)!;
  }

  async adminUpdate(id: string, patch: AdminUpdateUser): Promise<AdminUser> {
    const row = this.row(id);
    if (!row) throw notFound();
    if (id === OWNER_ID && patch.disabled) throw new HttpError(409, 'cannot_disable_admin');
    const set: Partial<typeof users.$inferInsert> = {};
    if (patch.disabled !== undefined) {
      set.disabledAt = patch.disabled ? (row.disabledAt ?? new Date().toISOString()) : null;
    }
    if (patch.password !== undefined) set.passwordHash = await hash(patch.password);
    if (Object.keys(set).length) this.db.update(users).set(set).where(eq(users.id, id)).run();
    if (patch.disabled || patch.password !== undefined) this.sessions.revokeAllFor(id);
    return this.list().find((u) => u.id === id)!;
  }

  /** Deletes an account with all its data and files. The admin cannot be deleted. */
  delete(id: string) {
    if (id === OWNER_ID) throw new HttpError(409, 'cannot_delete_admin');
    if (!this.row(id)) throw notFound();
    const files = this.db
      .select({ id: documents.id, filePath: documents.filePath })
      .from(documents)
      .where(eq(documents.userId, id))
      .all();
    // Rows go first (cascade from users); files are removed once nothing points at them.
    this.db.delete(users).where(eq(users.id, id)).run();
    for (const f of files) {
      fs.rmSync(f.filePath, { force: true });
      fs.rmSync(f.filePath.replace(/\.pdf$/, '.orig.pdf'), { force: true });
      fs.rmSync(path.join(this.config.coverDir, `${f.id}.webp`), { force: true });
    }
    fs.rmSync(this.claudeConfigDir(id), { recursive: true, force: true });
  }

  /** Claude Code's config dir (sessions, cache) for a user other than the admin. */
  claudeConfigDir(id: string) {
    return path.join(this.config.claudeUsersDir, id);
  }

  // ---- invitations ----------------------------------------------------------

  createInvitation(createdBy: string, note?: string): CreatedInvitation {
    const token = crypto.randomBytes(24).toString('base64url');
    const id = newId();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000).toISOString();
    this.db
      .insert(invitations)
      .values({ id, tokenHash: sha256(token), note: note || null, createdBy, expiresAt })
      .run();
    return { ...this.invitations().find((i) => i.id === id)!, token };
  }

  invitations(): Invitation[] {
    const usedBy = alias(users, 'used_by_user');
    return this.db
      .select({
        id: invitations.id,
        note: invitations.note,
        createdAt: invitations.createdAt,
        expiresAt: invitations.expiresAt,
        usedAt: invitations.usedAt,
        usedByUsername: usedBy.username,
      })
      .from(invitations)
      .leftJoin(usedBy, eq(usedBy.id, invitations.usedBy))
      .orderBy(desc(invitations.createdAt))
      .all();
  }

  deleteInvitation(id: string) {
    const res = this.db.delete(invitations).where(eq(invitations.id, id)).run();
    if (res.changes === 0) throw notFound();
  }

  /** An unused, unexpired invitation for this token, or undefined. */
  private openInvitation(token: string) {
    return this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, sha256(token)),
          isNull(invitations.usedAt),
          gt(invitations.expiresAt, new Date().toISOString()),
        ),
      )
      .get();
  }

  checkInvitation(token: string): boolean {
    return this.openInvitation(token) !== undefined;
  }

  /** Creates the account an invitation is for; the link cannot be used again. */
  async acceptInvitation(input: AcceptInvitation): Promise<UserRow> {
    if (!this.openInvitation(input.token)) throw new HttpError(410, 'invitation_invalid');
    const passwordHash = await hash(input.password);
    const id = newId();
    try {
      this.db.transaction((tx) => {
        // Checked again inside the transaction so two sign-ups cannot share a link.
        const inv = tx
          .select()
          .from(invitations)
          .where(and(eq(invitations.tokenHash, sha256(input.token)), isNull(invitations.usedAt)))
          .get();
        if (!inv) throw new HttpError(410, 'invitation_invalid');
        tx.insert(users)
          .values({
            id,
            username: input.username,
            displayName: input.displayName,
            passwordHash,
            role: 'user',
            lastLoginAt: new Date().toISOString(),
          })
          .run();
        tx.update(invitations)
          .set({ usedAt: new Date().toISOString(), usedBy: id })
          .where(eq(invitations.id, inv.id))
          .run();
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'username_taken');
      throw err;
    }
    return this.row(id)!;
  }

  private row(id: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }
}
