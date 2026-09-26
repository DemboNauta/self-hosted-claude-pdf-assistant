import {
  DEFAULT_PALETTE,
  DEFAULT_STUDY_TIMER,
  HIGHLIGHT_KEYS,
  type AppSettings,
  type PaletteEntry,
  type StudyTimerSettings,
} from '@pdfclaudeassistant/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { userSettings } from '../db/schema.js';

/** One user's settings, stored as JSON values in `user_settings` (SPEC §4 "Ajustes"). */
export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  read<T>(key: string): T | undefined {
    const row = this.db
      .select()
      .from(userSettings)
      .where(and(eq(userSettings.userId, this.userId), eq(userSettings.key, key)))
      .get();
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  write(key: string, value: unknown) {
    const json = JSON.stringify(value);
    this.db
      .insert(userSettings)
      .values({ userId: this.userId, key, value: json })
      .onConflictDoUpdate({
        target: [userSettings.userId, userSettings.key],
        set: { value: json },
      })
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
      studyTimer: {
        ...DEFAULT_STUDY_TIMER,
        ...this.read<Partial<StudyTimerSettings>>('study_timer'),
      },
    };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    if (patch.palette) this.write('palette', patch.palette);
    if (patch.claudeModel !== undefined) this.write('claude_model', patch.claudeModel);
    if (patch.studyTimer) this.write('study_timer', patch.studyTimer);
    return this.all();
  }

  /** Model chosen in Settings, overriding CLAUDE_MODEL (SPEC §6.4 "configurable"). */
  claudeModel(): string | null {
    return this.read<string | null>('claude_model') ?? null;
  }
}
