import type { Annotation } from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { Download, Eye, EyeOff, PenLine, Shapes, StickyNote } from 'lucide-react';
import { t } from '../../i18n';
import { SidePanelFrame } from '../reader/SidePanels';
import { useReader } from '../reader/store';
import { isVisible } from './AnnotationLayer';
import { setProposalStatus, useAnnotations, usePalette } from './api';

function Item({ a, colorOf }: { a: Annotation; colorOf: (k: string) => string }) {
  const quote = (a.anchor as { quote?: string }).quote;
  const icon =
    a.type === 'note' ? (
      <StickyNote size={12} aria-hidden />
    ) : a.type === 'drawing' ? (
      <PenLine size={12} aria-hidden />
    ) : a.type === 'shape' ? (
      <Shapes size={12} aria-hidden />
    ) : null;
  const label =
    quote ?? a.content ?? (a.type === 'drawing' ? t.annotations.drawing : t.annotations.shape);
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          useReader.getState().goTo(a.page, quote);
          useReader
            .getState()
            .setActiveAnnotation(a.type === 'highlight' || a.type === 'note' ? a.id : null);
          if (!window.matchMedia('(min-width: 768px)').matches) useReader.getState().closePanel();
        }}
        className="hover:bg-surface-muted flex w-full gap-2 px-3 py-2 text-left"
      >
        <span
          aria-hidden
          className={clsx(
            'mt-1 w-1 shrink-0 self-stretch rounded-full',
            a.status === 'proposed' && 'opacity-50',
          )}
          style={{ background: colorOf(a.color) }}
        />
        <span className="min-w-0 flex-1">
          <span className="text-text-muted flex items-center gap-1 text-xs">
            {icon}
            p. {a.page} · {a.author === 'claude' ? t.annotations.byClaude : t.annotations.byYou}
          </span>
          <span className={clsx('line-clamp-3 text-sm', quote && 'italic')}>{label}</span>
          {quote && a.content && (
            <span className="text-text-muted line-clamp-2 block text-xs">{a.content}</span>
          )}
        </span>
      </button>
    </li>
  );
}

/** Side panel listing the document's annotations, with filters (F-ANN-05, F-ANN-07). */
export function AnnotationsPanel({ docId }: { docId: string }) {
  const { data = [] } = useAnnotations(docId);
  const filter = useReader((s) => s.filter);
  const setFilter = useReader((s) => s.setFilter);
  const { palette, colorOf } = usePalette();
  const proposals = data.filter((a) => a.status === 'proposed');
  const shown = data.filter((a) => isVisible(a, { ...filter, visible: true }));

  const chip = (
    key: string,
    active: boolean,
    onClick: () => void,
    children: React.ReactNode,
    label?: string,
  ) => (
    <button
      key={key}
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={clsx(
        'rounded-full border px-2 py-0.5 text-xs',
        active ? 'border-text' : 'border-border text-text-muted line-through',
      )}
    >
      {children}
    </button>
  );

  return (
    <SidePanelFrame title={t.annotations.title}>
      <div className="border-border space-y-2 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setFilter({ visible: !filter.visible })}
            aria-pressed={filter.visible}
            className="text-text-muted hover:text-text flex items-center gap-1.5 text-sm"
          >
            {filter.visible ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
            {t.annotations.showLayer}
          </button>
          <a
            href={`/api/documents/${docId}/export-annotated`}
            download
            className="text-text-muted hover:text-text flex items-center gap-1 text-sm"
            title={t.annotations.export}
          >
            <Download size={14} aria-hidden />
            PDF
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" aria-label={t.annotations.filters}>
          {chip('mine', filter.mine, () => setFilter({ mine: !filter.mine }), t.annotations.mine)}
          {chip(
            'claude',
            filter.claude,
            () => setFilter({ claude: !filter.claude }),
            t.annotations.claude,
          )}
          {palette.map((p) =>
            chip(
              p.key,
              !filter.hiddenColors.includes(p.key),
              () =>
                setFilter({
                  hiddenColors: filter.hiddenColors.includes(p.key)
                    ? filter.hiddenColors.filter((k) => k !== p.key)
                    : [...filter.hiddenColors, p.key],
                }),
              <span
                className="inline-block size-2.5 rounded-full align-middle"
                style={{ background: p.color }}
              />,
              p.meaning,
            ),
          )}
        </div>
        {proposals.length > 0 && (
          <div className="bg-surface-muted flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-xs">
            <span className="flex-1">{t.annotations.proposals(proposals.length)}</span>
            <button
              type="button"
              onClick={() =>
                void setProposalStatus(
                  docId,
                  proposals.map((p) => p.id),
                  'active',
                )
              }
              className="font-medium hover:underline"
            >
              {t.annotations.acceptAll}
            </button>
            <button
              type="button"
              onClick={() =>
                void setProposalStatus(
                  docId,
                  proposals.map((p) => p.id),
                  'rejected',
                )
              }
              className="text-text-muted hover:underline"
            >
              {t.annotations.rejectAll}
            </button>
          </div>
        )}
      </div>
      {data.length === 0 ? (
        <p className="text-text-muted p-3 text-sm">{t.annotations.empty}</p>
      ) : shown.length === 0 ? (
        <p className="text-text-muted p-3 text-sm">{t.annotations.noMatches}</p>
      ) : (
        <ul className="py-1">
          {shown.map((a) => (
            <Item key={a.id} a={a} colorOf={colorOf} />
          ))}
        </ul>
      )}
    </SidePanelFrame>
  );
}
