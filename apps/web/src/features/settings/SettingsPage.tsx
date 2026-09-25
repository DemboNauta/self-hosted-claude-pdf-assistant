import clsx from 'clsx';
import { Page } from '../../components/Page';
import { t } from '../../i18n';
import { useThemeStore, type ThemePreference } from '../../lib/theme';
import { ClaudeConnection } from './ClaudeConnection';

const THEMES: ThemePreference[] = ['system', 'light', 'dark'];

export function SettingsPage() {
  const { preference, setPreference } = useThemeStore();
  return (
    <Page title={t.settings.title}>
      <div className="space-y-12">
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
        </section>
        <ClaudeConnection />
      </div>
    </Page>
  );
}
