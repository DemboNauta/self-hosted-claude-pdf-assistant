import clsx from 'clsx';
import {
  ArrowLeft,
  Brain,
  Highlighter,
  LayoutGrid,
  ListTree,
  Minus,
  Plus,
  Search,
  type LucideIcon,
  Workflow,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Menu } from '../../components/Menu';
import { t } from '../../i18n';
import { TimerToggle } from '../timer/TimerToggle';
import { requestZoom } from './PdfViewer';
import { useReader, ZOOM_STEPS, type SidePanel } from './store';

function IconButton({
  label,
  icon: Icon,
  onClick,
  pressed,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={clsx(
        'rounded-md p-2',
        pressed
          ? 'bg-surface-muted text-text'
          : 'text-text-muted hover:text-text hover:bg-surface-muted',
      )}
    >
      <Icon size={18} aria-hidden />
    </button>
  );
}

/** Page number field: shows the current page, jumps on Enter. */
function PageInput() {
  const currentPage = useReader((s) => s.currentPage);
  const pageCount = useReader((s) => s.pageCount);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(draft);
        if (Number.isFinite(n) && n >= 1) useReader.getState().goTo(n);
        setDraft(null);
      }}
      className="text-text-muted flex items-center gap-1.5 text-sm"
    >
      <input
        aria-label={t.reader.page}
        inputMode="numeric"
        value={draft ?? String(currentPage)}
        onFocus={(e) => {
          setDraft(String(currentPage));
          e.target.select();
        }}
        onBlur={() => setDraft(null)}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        className="border-border bg-bg text-text w-12 rounded-md border px-1.5 py-1 text-center tabular-nums"
      />
      <span className="hidden whitespace-nowrap sm:inline">{t.reader.of(pageCount)}</span>
    </form>
  );
}

function ZoomControls() {
  const scale = useReader((s) => s.scale);
  const zoomMode = useReader((s) => s.zoomMode);
  const setZoom = useReader((s) => s.setZoom);
  const step = (dir: 1 | -1) => {
    const next =
      dir > 0
        ? ZOOM_STEPS.find((z) => z > scale + 0.01)
        : [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.01);
    requestZoom(next ?? scale);
  };
  const value = zoomMode === 'custom' ? 'custom' : zoomMode;
  return (
    <div className="hidden items-center sm:flex">
      <IconButton label={t.reader.zoomOut} icon={Minus} onClick={() => step(-1)} />
      <select
        aria-label={t.reader.zoom}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'fit-width' || v === 'fit-page') setZoom(v);
          else if (v !== 'custom') requestZoom(Number(v));
        }}
        className="bg-bg text-text hidden rounded-md px-1 py-1 text-sm tabular-nums sm:block"
      >
        <option value="custom">{Math.round(scale * 100)}%</option>
        <option value="fit-width">{t.reader.fitWidth}</option>
        <option value="fit-page">{t.reader.fitPage}</option>
        {ZOOM_STEPS.map((z) => (
          <option key={z} value={z}>
            {Math.round(z * 100)}%
          </option>
        ))}
      </select>
      <IconButton label={t.reader.zoomIn} icon={Plus} onClick={() => step(1)} />
    </div>
  );
}

const PANELS: { id: Exclude<SidePanel, null>; label: string; icon: LucideIcon }[] = [
  { id: 'thumbnails', label: t.reader.thumbnails, icon: LayoutGrid },
  { id: 'outline', label: t.reader.outline, icon: ListTree },
  { id: 'search', label: t.reader.search, icon: Search },
  { id: 'annotations', label: t.annotations.title, icon: Highlighter },
  { id: 'memory', label: t.memory.panel, icon: Brain },
  { id: 'diagrams', label: t.diagrams.panel, icon: Workflow },
];

export function ReaderToolbar({
  title,
  backTo,
  trailing,
}: {
  title: string;
  backTo: string;
  trailing?: ReactNode;
}) {
  const panel = useReader((s) => s.panel);
  const togglePanel = useReader((s) => s.togglePanel);
  return (
    <header className="border-border bg-surface flex items-center gap-1 border-b px-2 py-1.5">
      <Link
        to={backTo}
        aria-label={t.reader.back}
        title={t.reader.back}
        className="text-text-muted hover:text-text hover:bg-surface-muted rounded-md p-2"
      >
        <ArrowLeft size={18} aria-hidden />
      </Link>
      <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{title}</h1>
      <div className="hidden items-center sm:flex">
        {PANELS.map((p) => (
          <IconButton
            key={p.id}
            label={p.label}
            icon={p.icon}
            pressed={panel === p.id}
            onClick={() => togglePanel(p.id)}
          />
        ))}
      </div>
      <Menu
        label={t.reader.panels}
        className="sm:hidden"
        actions={PANELS.map((p) => ({ label: p.label, onSelect: () => togglePanel(p.id) }))}
      />
      <div className="bg-border mx-1 hidden h-5 w-px sm:block" aria-hidden />
      <PageInput />
      <ZoomControls />
      <TimerToggle />
      {trailing}
    </header>
  );
}
