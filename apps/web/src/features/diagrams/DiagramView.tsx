import type { Diagram } from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { Download, Maximize2, Workflow, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Menu } from '../../components/Menu';
import { t } from '../../i18n';
import { CitationChip } from '../chat/CitationChip';
import { useDiagram } from './api';
import { renderDiagram } from './mermaid';
import { PanZoom } from './PanZoom';

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
const isDark = () => document.documentElement.dataset.theme === 'dark';

/** The rendered SVG of a diagram, re-rendered when its source or the theme changes. */
function useDiagramSvg(source: string) {
  const dark = useSyncExternalStore(subscribeTheme, isDark);
  const [state, setState] = useState<{ key: string; svg?: string; error?: string }>({ key: '' });
  const key = `${dark ? 'd' : 'l'}:${source}`;
  useEffect(() => {
    let cancelled = false;
    renderDiagram(source, dark).then(
      (svg) => !cancelled && setState({ key, svg }),
      (err: unknown) => !cancelled && setState({ key, error: String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [source, dark, key]);
  return state.key === key ? state : { key, svg: undefined, error: undefined };
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'esquema';

/** Size Mermaid laid the diagram out at (from the SVG viewBox). */
function naturalSize(svg: string): { width: number; height: number } {
  const m = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 800, height: 600 };
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadPng(svg: string, name: string) {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, img.naturalWidth * scale);
  canvas.height = Math.max(1, img.naturalHeight * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => blob && save(blob, name), 'image/png');
}

function Pages({ diagram }: { diagram: Diagram }) {
  if (!diagram.documentId || !diagram.fromPage) return null;
  const label =
    diagram.toPage && diagram.toPage !== diagram.fromPage
      ? t.diagrams.pages(diagram.fromPage, diagram.toPage)
      : null;
  return (
    <span className="text-text-muted flex items-center gap-1 text-xs">
      <CitationChip citation={{ docId: diagram.documentId, page: diagram.fromPage }} />
      {label}
    </span>
  );
}

/**
 * A diagram with its title and actions. "inline" is the compact view in the chat and
 * the lists (click to enlarge); "full" fills the viewer, with zoom.
 */
export function DiagramView({
  diagram,
  variant = 'inline',
  onExpand,
}: {
  diagram: Diagram;
  variant?: 'inline' | 'full';
  onExpand?: () => void;
}) {
  const { svg, error } = useDiagramSvg(diagram.source);
  const file = slug(diagram.title);
  const full = variant === 'full';

  return (
    <figure
      data-testid="diagram"
      className={clsx(
        'flex min-h-0 flex-col',
        full ? 'h-full flex-1' : 'border-border rounded-xl border',
      )}
    >
      <figcaption className="flex items-center gap-2 px-3 py-2">
        <Workflow size={14} aria-hidden className="text-text-muted shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{diagram.title}</span>
        <Pages diagram={diagram} />
        {svg && (
          <Menu
            label={t.diagrams.download}
            icon={<Download size={16} aria-hidden />}
            actions={[
              {
                label: t.diagrams.downloadSvg,
                onSelect: () => save(new Blob([svg], { type: 'image/svg+xml' }), `${file}.svg`),
              },
              {
                label: t.diagrams.downloadPng,
                onSelect: () => void downloadPng(svg, `${file}.png`),
              },
            ]}
          />
        )}
        {!full && onExpand && (
          <button
            type="button"
            onClick={onExpand}
            aria-label={t.diagrams.expand}
            title={t.diagrams.expand}
            className="text-text-muted hover:text-text rounded p-1"
          >
            <Maximize2 size={16} aria-hidden />
          </button>
        )}
      </figcaption>
      {error ? (
        <div role="alert" className="text-danger space-y-2 px-3 pb-3 text-sm">
          <p>{t.diagrams.renderError}</p>
          <pre className="bg-surface-muted text-text overflow-auto rounded p-2 text-xs">
            {diagram.source}
          </pre>
        </div>
      ) : !svg ? (
        <p className="text-text-muted py-6 text-center text-sm">{t.diagrams.rendering}</p>
      ) : full ? (
        <PanZoom {...naturalSize(svg)} label={diagram.title}>
          <div
            className="diagram-svg h-full w-full [&_svg]:h-full! [&_svg]:w-full! [&_svg]:max-w-none!"
            // Mermaid's own output, sanitised by its strict security level.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </PanZoom>
      ) : (
        <div className="max-h-96 cursor-zoom-in overflow-hidden px-3 pb-3" onClick={onExpand}>
          <div
            className="diagram-svg [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </figure>
  );
}

/**
 * Full-screen viewer. A native modal <dialog> (top layer), so it also opens above other
 * modal dialogs, such as the questions asked about a passage.
 */
export function DiagramDialog({ diagram, onClose }: { diagram: Diagram; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={diagram.title}
      className="bg-bg text-text m-0 h-full max-h-none w-full max-w-none p-0"
    >
      <div className="flex h-full flex-col">
        <div className="absolute top-2 right-2 z-10">
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label={t.diagrams.close}
            className="bg-surface border-border text-text-muted hover:text-text rounded-lg border p-1.5"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col pt-1 pr-12">
          <DiagramView diagram={diagram} variant="full" />
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

/** `[[diagram:ID]]` in a chat answer. */
export function DiagramEmbed({ id }: { id: string }) {
  const { data, isError } = useDiagram(id);
  const [open, setOpen] = useState(false);
  if (isError) return <p className="text-text-muted my-2 text-xs italic">{t.diagrams.gone}</p>;
  if (!data) return <p className="text-text-muted my-2 text-xs">{t.diagrams.rendering}</p>;
  return (
    <div className="my-2">
      <DiagramView diagram={data} onExpand={() => setOpen(true)} />
      {open && <DiagramDialog diagram={data} onClose={() => setOpen(false)} />}
    </div>
  );
}
