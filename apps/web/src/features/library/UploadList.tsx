import clsx from 'clsx';
import { X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { t } from '../../i18n';
import { useUploads, type UploadItem } from './uploads';

const ERRORS: Record<string, string> = {
  not_a_pdf: t.library.upload.notPdf,
  file_too_large: t.library.upload.tooLarge,
  unknown_topic: t.library.upload.unknownTopic,
};

function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function label(item: UploadItem) {
  switch (item.state) {
    case 'waiting':
    case 'uploading':
      return `${t.library.upload.uploading} · ${formatBytes(item.sent)} / ${formatBytes(item.size)}`;
    case 'retrying':
      return t.library.upload.retrying;
    case 'done':
      return t.library.upload.done;
    case 'error':
      return ERRORS[item.error ?? ''] ?? t.library.upload.failed;
    case 'cancelled':
      return '';
  }
}

/** Uploads into this topic with byte progress (the "subiendo" stage of F-ING-05). */
export function UploadList({ topicId }: { topicId: string }) {
  const items = useUploads(
    useShallow((s) =>
      s.items.filter((i) => i.topicId === topicId && i.state !== 'cancelled' && i.state !== 'done'),
    ),
  );
  const { cancel, dismiss } = useUploads.getState();
  if (items.length === 0) return null;

  return (
    <ul className="mb-6 space-y-2" aria-label={t.library.upload.uploading}>
      {items.map((item) => {
        const active =
          item.state === 'waiting' || item.state === 'uploading' || item.state === 'retrying';
        const pct = item.size ? Math.round((item.sent / item.size) * 100) : 0;
        return (
          <li
            key={item.key}
            className="border-border bg-surface flex items-center gap-3 rounded-lg border px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{item.name}</p>
              <p
                role="status"
                className={clsx(
                  'text-xs',
                  item.state === 'error' ? 'text-danger' : 'text-text-muted',
                )}
              >
                {label(item)}
              </p>
              {active && (
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  aria-label={item.name}
                  className="bg-surface-muted mt-1.5 h-1 overflow-hidden rounded-full"
                >
                  <div className="bg-text h-full transition-[width]" style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => (active ? cancel(item.key) : dismiss(item.key))}
              aria-label={active ? t.library.upload.cancel : t.library.upload.dismiss}
              className="text-text-muted hover:text-text rounded p-1"
            >
              <X size={16} aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
