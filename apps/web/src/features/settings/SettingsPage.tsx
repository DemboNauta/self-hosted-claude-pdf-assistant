import clsx from 'clsx';
import { Page } from '../../components/Page';
import { t } from '../../i18n';
import { useThemeStore, type ThemePreference } from '../../lib/theme';
import { SHORTCUTS } from '../reader/shortcuts';
import { AccountSettings } from './AccountSettings';
import { ClaudeConnection } from './ClaudeConnection';
import { StudySettings } from './StudySettings';

const THEMES: ThemePreference[] = ['system', 'light', 'dark'];

export function SettingsPage() {
  const { preference, setPreference, darkPdf, setDarkPdf } = useThemeStore();
  return (
    <Page title={t.settings.title}>
      <div className="space-y-12">
        <AccountSettings />
        <section aria-labelledby="theme" className="space-y-4">
          <h2 id="theme" className="text-lg font-medium">
            {t.settings.theme.title}
          </h2>
          <div
            role="radiogroup"
            aria-labelledby="theme"
            className="inline-flex rounded-lg border border-border p-1"
          >
            {THEMES.map((th) => (
              <button
                key={th}
                type="button"
                role="radio"
                aria-checked={preference === th}
                onClick={() => setPreference(th)}
                className={clsx(
                  'rounded-md px-3 py-1.5 text-sm',
                  preference === th ? 'bg-surface-muted font-medium' : 'text-text-muted',
                )}
              >
                {t.settings.theme[th]}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={darkPdf}
              onChange={(e) => setDarkPdf(e.target.checked)}
              className="size-4"
            />
            {t.settings.theme.darkPdf}
          </label>
        </section>
        <ClaudeConnection />
        <StudySettings />
        <section aria-labelledby="shortcuts" className="hidden space-y-4 lg:block">
          <h2 id="shortcuts" className="text-lg font-medium">
            {t.shortcuts.title}
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {SHORTCUTS.map(([keys, label]) => (
              <div key={keys} className="contents">
                <dt>
                  <kbd className="bg-surface-muted rounded px-1.5 py-0.5 font-mono text-xs">
                    {keys}
                  </kbd>
                </dt>
                <dd>{label}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </Page>
  );
}
