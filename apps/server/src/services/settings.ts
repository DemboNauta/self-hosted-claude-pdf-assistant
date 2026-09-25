import {
  DEFAULT_PALETTE,
  HIGHLIGHT_KEYS,
  type AppSettings,
  type PaletteEntry,
} from '@pdfclaudeassistant/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';

/** User settings stored as JSON values in the `settings` table (SPEC §4 "Ajustes"). */
export class SettingsService {
  constructor(private readonly db: Db) {}

  private read<T>(key: string): T | undefined {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  private write(key: string, value: unknown) {
    const json = JSON.stringify(value);
    this.db
      .insert(settings)
      .values({ key, value: json })
      .onConflictDoUpdate({ target: settings.key, set: { value: json } })
      .run();
  }

  palette(): PaletteEntry[] {
    const saved = this.read<PaletteEntry[]>('palette') ?? [];
    // Always the five keys, in order, falling back to the defaults.
    return HIGHLIGHT_KEYS.map(
      (key) => saved.find((p) => p.key === key) ?? DEFAULT_PALETTE.find((p) => p.key === key)!,
    );
  }

  all(): AppSettings {
    return {
      palette: this.palette(),
      claudeModel: this.read<string>('claude_model') ?? null,
    };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    if (patch.palette) this.write('palette', patch.palette);
    if (patch.claudeModel !== undefined) this.write('claude_model', patch.claudeModel);
    return this.all();
  }

  /** Model chosen in Settings, overriding CLAUDE_MODEL (SPEC §6.4 "configurable"). */
  claudeModel(): string | null {
    return this.read<string | null>('claude_model') ?? null;
  }
}
