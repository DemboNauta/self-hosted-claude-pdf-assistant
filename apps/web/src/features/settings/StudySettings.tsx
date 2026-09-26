import type { AppSettings, PaletteEntry } from '@pdfclaudeassistant/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { t } from '../../i18n';
import { useCurrentUser } from '../auth/session';
import { api } from '../../lib/api';
import { settingsKey, useSettings } from '../annotations/api';

const MODELS = ['', 'opus', 'sonnet', 'haiku'];

/** Highlight meanings (resolved decision #2, configurable), Claude model and backup. */
export function StudySettings() {
  const settings = useSettings();
  return settings.data ? <StudySettingsForm initial={settings.data} /> : null;
}

function StudySettingsForm({ initial }: { initial: AppSettings }) {
  const qc = useQueryClient();
  const [palette, setPalette] = useState<PaletteEntry[]>(initial.palette);
  const [model, setModel] = useState<string>(initial.claudeModel ?? '');
  const [saved, setSaved] = useState(false);
  // The backup holds every user's data: only the admin downloads it.
  const isAdmin = useCurrentUser()?.role === 'admin';

  const save = async (patch: Partial<AppSettings>) => {
    const next = await api<AppSettings>('/settings', { method: 'PATCH', json: patch });
    qc.setQueryData(settingsKey, next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const custom = !MODELS.includes(model);

  return (
    <>
      <section aria-labelledby="palette" className="space-y-4">
        <h2 id="palette" className="text-lg font-medium">
          {t.settings.palette.title}
        </h2>
        <p className="text-text-muted text-sm">{t.settings.palette.help}</p>
        <ul className="space-y-2">
          {palette.map((p, i) => (
            <li key={p.key} className="flex items-center gap-3">
              <input
                type="color"
                value={p.color}
                aria-label={t.settings.palette.color(p.meaning)}
                onChange={(e) =>
                  setPalette(palette.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))
                }
                className="size-8 cursor-pointer rounded border-0 bg-transparent"
              />
              <input
                value={p.meaning}
                maxLength={60}
                aria-label={t.settings.palette.meaning(i + 1)}
                onChange={(e) =>
                  setPalette(
                    palette.map((x, j) => (j === i ? { ...x, meaning: e.target.value } : x)),
                  )
                }
                className="border-border bg-surface min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-sm"
              />
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() =>
            void save({ palette: palette.map((p) => ({ ...p, meaning: p.meaning.trim() || '—' })) })
          }
          className="bg-accent text-accent-contrast rounded-lg px-3 py-1.5 text-sm font-medium"
        >
          {t.settings.save}
        </button>
      </section>

      <section aria-labelledby="model" className="space-y-3">
        <h2 id="model" className="text-lg font-medium">
          {t.settings.model.title}
        </h2>
        <p className="text-text-muted text-sm">{t.settings.model.help}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={custom ? 'custom' : model}
            aria-label={t.settings.model.title}
            onChange={(e) => setModel(e.target.value === 'custom' ? 'claude-' : e.target.value)}
            className="border-border bg-surface rounded-lg border px-3 py-1.5 text-sm"
          >
            <option value="">{t.settings.model.default}</option>
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
            <option value="custom">{t.settings.model.custom}</option>
          </select>
          {custom && (
            <input
              value={model}
              onChange={(e) => setModel(e.target.value.trim())}
              aria-label={t.settings.model.custom}
              className="border-border bg-surface rounded-lg border px-3 py-1.5 font-mono text-sm"
            />
          )}
          <button
            type="button"
            onClick={() => void save({ claudeModel: model || null })}
            className="bg-accent text-accent-contrast rounded-lg px-3 py-1.5 text-sm font-medium"
          >
            {t.settings.save}
          </button>
        </div>
      </section>

      {saved && (
        <p role="status" className="text-ok text-sm">
          {t.settings.saved}
        </p>
      )}

      {isAdmin && (
        <section aria-labelledby="backup" className="space-y-3">
          <h2 id="backup" className="text-lg font-medium">
            {t.settings.backup.title}
          </h2>
          <p className="text-text-muted text-sm">{t.settings.backup.help}</p>
          <a
            href="/api/backup"
            download
            className="border-border hover:bg-surface-muted inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
          >
            <Download size={16} aria-hidden />
            {t.settings.backup.download}
          </a>
        </section>
      )}
    </>
  );
}
