import { Link } from 'react-router';
import { t } from '../../i18n';
import { SidePanelFrame } from '../reader/SidePanels';
import { ConceptList, useMemory } from './MemoryPage';

/** Reader side panel: what Claude remembers about this document (F-MEM-02/03/05). */
export function MemoryPanel({ docId }: { docId: string }) {
  const { data } = useMemory();
  const items = data?.documents.filter((m) => m.documentId === docId) ?? [];
  const concepts = data?.concepts.filter((c) => c.documentId === docId) ?? [];
  return (
    <SidePanelFrame title={t.memory.panel}>
      <div className="space-y-6 p-3">
        <section className="space-y-2">
          <h3 className="text-text-muted text-xs font-medium tracking-wide uppercase">
            {t.memory.thisDocument}
          </h3>
          {items.length ? (
            <ul className="space-y-2 text-sm">
              {items.map((m) => (
                <li key={m.id}>
                  <span className="text-text-muted text-xs">
                    {t.memory.categories[m.category]} ·{' '}
                  </span>
                  {m.content}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-text-muted text-sm">{t.memory.emptyDocuments}</p>
          )}
        </section>
        <section className="space-y-2">
          <h3 className="text-text-muted text-xs font-medium tracking-wide uppercase">
            {t.memory.concepts}
          </h3>
          {concepts.length ? (
            <ConceptList concepts={concepts} />
          ) : (
            <p className="text-text-muted text-sm">{t.memory.emptyConcepts}</p>
          )}
        </section>
        <Link to="/memory" className="text-text-muted block text-sm underline">
          {t.memory.title}
        </Link>
      </div>
    </SidePanelFrame>
  );
}
