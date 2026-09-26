import { Workflow } from 'lucide-react';
import { t } from '../../i18n';
import { useChatDock } from '../chat/ChatDock';
import { useChat } from '../chat/store';
import { SidePanelFrame } from '../reader/SidePanels';
import { useDocumentDiagrams } from './api';
import { DiagramList } from './DiagramList';

/** Reader side panel: the diagrams of this PDF, and a shortcut to ask for a new one. */
export function DiagramsPanel({ docId }: { docId: string }) {
  const { data } = useDocumentDiagrams(docId);
  return (
    <SidePanelFrame title={t.diagrams.panel}>
      <div className="space-y-3 p-3">
        <button
          type="button"
          onClick={() => {
            useChat.getState().setMode('diagram');
            useChatDock.getState().show();
            setTimeout(() => window.dispatchEvent(new CustomEvent('pca:focus-composer')), 50);
          }}
          className="border-border hover:bg-surface-muted flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm"
        >
          <Workflow size={16} aria-hidden />
          {t.diagrams.create}
        </button>
        {data?.length ? (
          <DiagramList diagrams={data} />
        ) : (
          <p className="text-text-muted text-sm">{t.diagrams.emptyDoc}</p>
        )}
      </div>
    </SidePanelFrame>
  );
}
