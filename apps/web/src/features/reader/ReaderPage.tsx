import { Page } from '../../components/Page';
import { t } from '../../i18n';

/** Placeholder until the PDF viewer lands (F-VIS-01). */
export function ReaderPage() {
  return (
    <Page title={t.nav.read}>
      <p className="text-text-muted">{t.reader.comingSoon}</p>
    </Page>
  );
}
