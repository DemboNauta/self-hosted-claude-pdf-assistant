import { Page } from '../../components/Page';
import { t } from '../../i18n';

export function HomePage() {
  return (
    <Page title={t.home.title}>
      <p className="text-text-muted">{t.home.welcome}</p>
    </Page>
  );
}
