import crypto from 'node:crypto';

/**
 * Encrypts small secrets at rest (users' Claude tokens) with AES-256-GCM. The key is
 * derived from SESSION_SECRET, so the database alone (e.g. a backup) does not reveal
 * them; changing SESSION_SECRET makes saved tokens unreadable and users re-enter them.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(sessionSecret: string) {
    this.key = Buffer.from(
      crypto.hkdfSync('sha256', sessionSecret, 'pdfclaudeassistant', 'claude-token', 32),
    );
  }

  seal(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), data]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  /** Null when the value was sealed with another key or is damaged. */
  open(sealed: string): string | null {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !data) return null;
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
