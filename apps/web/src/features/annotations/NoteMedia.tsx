import {
  CLAUDE_COLOR,
  type Annotation,
  type NoteImage,
  type SavedBoardRef,
} from '@pdfclaudeassistant/shared';
import clsx from 'clsx';
import { ExternalLink, ImagePlus, Loader2, PenLine, Presentation, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n';
import { openSavedBoard } from '../whiteboard/store';
import {
  addNoteImage,
  boardSnapshotUrl,
  noteImageUrl,
  removeNoteImage,
  setNoteImageCaption,
} from './api';
import { imageErrorText, prepareImage } from './images';

type Shown = { kind: 'image'; image: NoteImage } | { kind: 'board'; board: SavedBoardRef };

/**
 * Adds pictures to a note (files, camera, paste or drop): shrinks each one and uploads
 * it, reporting errors in words. Returned so the popover can use it for paste/drop.
 */
export function useImageUpload(docId: string, annotationId: string) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const upload = async (files: Blob[]) => {
    if (!files.length) return;
    setError(null);
    setBusy((n) => n + files.length);
    for (const file of files) {
      try {
        await addNoteImage(docId, annotationId, await prepareImage(file));
      } catch (err) {
        setError(imageErrorText(err));
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };
  return { upload, busy: busy > 0, error };
}

/**
 * What a note holds besides its text: the whiteboard saved in it and its pictures, as
 * thumbnails that open full size. `editable` adds "Añadir imagen" and removal.
 */
export function NoteMedia({
  docId,
  annotation: a,
  editable,
  upload,
  compact = false,
}: {
  docId: string;
  annotation: Annotation;
  editable: boolean;
  upload?: ReturnType<typeof useImageUpload>;
  /** Small thumbnails (Claude's margin cards). */
  compact?: boolean;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const has = a.board || a.images.length > 0;
  if (!has && !editable) return null;
  const thumb = compact ? 'h-14' : 'h-20';

  return (
    <div className="mb-2 shrink-0" data-testid="note-media">
      {has && (
        <div className="flex flex-wrap gap-1.5">
          {a.board && (
            <button
              type="button"
              onClick={() => setShown({ kind: 'board', board: a.board! })}
              aria-label={t.annotations.board.open}
              title={t.annotations.board.open}
              data-testid="note-board"
              className={clsx(
                'border-border bg-white relative overflow-hidden rounded-md border',
                compact ? 'h-14 w-20' : 'h-20 w-28',
              )}
            >
              <img
                src={boardSnapshotUrl(a.board)}
                alt=""
                className="size-full object-contain"
                onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
              />
              <Presentation
                size={14}
                aria-hidden
                className="text-text-muted absolute right-1 bottom-1 rounded bg-white/80 p-px"
              />
            </button>
          )}
          {a.images.map((img, i) => (
            <span key={img.id} className="group relative">
              <button
                type="button"
                onClick={() => setShown({ kind: 'image', image: img })}
                aria-label={img.caption ?? t.annotations.images.open(i + 1)}
                title={img.caption ?? undefined}
                data-testid="note-image"
                className={clsx('border-border block overflow-hidden rounded-md border', thumb)}
                style={{
                  aspectRatio: `${img.width} / ${img.height}`,
                  maxWidth: compact ? 120 : 200,
                }}
              >
                <img
                  src={noteImageUrl(img.id)}
                  alt={img.caption ?? ''}
                  loading="lazy"
                  className="size-full object-cover"
                />
              </button>
              {img.source === 'claude' && (
                <Sparkles
                  size={12}
                  role="img"
                  aria-label={t.annotations.images.fromClaude}
                  className="pointer-events-none absolute bottom-1 left-1 rounded bg-white/85 p-px"
                  style={{ color: CLAUDE_COLOR }}
                />
              )}
              {editable && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(t.annotations.images.removeConfirm))
                      void removeNoteImage(docId, img.id);
                  }}
                  aria-label={t.annotations.images.remove}
                  title={t.annotations.images.remove}
                  className="bg-surface text-text absolute -top-1.5 -right-1.5 rounded-full border p-0.5 opacity-0 shadow group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(pointer:coarse)]:opacity-100"
                >
                  <X size={12} aria-hidden />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {a.board?.pending && (
        <p className="text-text-muted mt-1 text-xs">{t.annotations.board.pending}</p>
      )}
      {editable && upload && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => input.current?.click()}
            title={t.annotations.images.addHint}
            className="hover:bg-surface-muted text-text-muted hover:text-text flex items-center gap-1 rounded-md px-1.5 py-1 text-xs"
          >
            {upload.busy ? (
              <Loader2 size={14} aria-hidden className="animate-spin" />
            ) : (
              <ImagePlus size={14} aria-hidden />
            )}
            {upload.busy ? t.annotations.images.adding : t.annotations.images.add}
          </button>
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-testid="note-image-input"
            onChange={(e) => {
              void upload.upload([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          {upload.error && (
            <span role="alert" className="text-danger text-xs">
              {upload.error}
            </span>
          )}
        </div>
      )}
      {shown && (
        <MediaViewer
          docId={docId}
          annotation={a}
          shown={shown}
          editable={editable}
          onClose={() => setShown(null)}
        />
      )}
    </div>
  );
}

/** A picture or the saved whiteboard at full size, over everything. */
function MediaViewer({
  docId,
  annotation: a,
  shown,
  editable,
  onClose,
}: {
  docId: string;
  annotation: Annotation;
  shown: Shown;
  editable: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const image = shown.kind === 'image' ? shown.image : null;
  const [caption, setCaption] = useState(image?.caption ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const saveCaption = () => {
    if (!image) return;
    const next = caption.trim() || null;
    if (next !== (image.caption ?? null)) void setNoteImageCaption(docId, image.id, next);
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image ? t.annotations.images.viewer : t.annotations.board.label}
      data-annotation-ui
      data-testid="media-viewer"
      className="fixed inset-0 z-[60] flex flex-col bg-black/85 p-3 text-white"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex shrink-0 items-center gap-2 pb-2">
        <span className="flex-1 truncate text-sm opacity-80">
          {image ? (image.caption ?? t.annotations.images.viewer) : t.annotations.board.label}
          {' · p. '}
          {a.page}
        </span>
        {shown.kind === 'board' && !shown.board.pending && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              openSavedBoard(shown.board.id)
                .then((opened) => opened && onClose())
                .catch(() => setError(t.board.openFailed));
            }}
            className="flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black"
          >
            <PenLine size={16} aria-hidden />
            {t.annotations.board.edit}
          </button>
        )}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={t.annotations.images.close}
          className="rounded-md p-1.5 hover:bg-white/15"
        >
          <X size={20} aria-hidden />
        </button>
      </div>
      {error && (
        <p role="alert" className="pb-2 text-sm text-red-300">
          {error}
        </p>
      )}
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <img
          src={
            shown.kind === 'image' ? noteImageUrl(shown.image.id) : boardSnapshotUrl(shown.board)
          }
          alt={image?.caption ?? ''}
          className={clsx(
            'max-h-full max-w-full rounded object-contain',
            shown.kind === 'board' && 'bg-white',
          )}
        />
      </div>
      {image && (
        <div className="mx-auto flex w-full max-w-2xl shrink-0 flex-col gap-1 pt-2 text-sm">
          {editable ? (
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onBlur={saveCaption}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              maxLength={300}
              placeholder={t.annotations.images.captionPlaceholder}
              aria-label={t.annotations.images.caption}
              className="rounded-md border border-white/30 bg-transparent px-2 py-1 text-white placeholder:text-white/50"
            />
          ) : (
            image.caption && <p>{image.caption}</p>
          )}
          {(image.credit || image.sourceUrl) && (
            <p className="text-xs opacity-75">
              {image.credit}
              {image.sourceUrl && (
                <>
                  {image.credit && ' · '}
                  <a
                    href={image.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 underline"
                  >
                    {t.annotations.images.source}
                    <ExternalLink size={11} aria-hidden />
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
