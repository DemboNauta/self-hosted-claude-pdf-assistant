import { useCallback, useEffect, useState } from 'react';

/** Layout of the annotation popover for the available screen size. */
export type PopoverLayout = 'phone' | 'tablet' | 'desktop';

export interface PopoverSize {
  /** Width in px (floating layouts only; the phone sheet is always full width). */
  w: number;
  /** Height in px, or null to fit the content. */
  h: number | null;
}

const PHONE = '(max-width: 767px)';
const DESKTOP = '(min-width: 1024px)';

export const DEFAULT_SIZE: Record<PopoverLayout, PopoverSize> = {
  phone: { w: 0, h: null },
  tablet: { w: 360, h: null },
  desktop: { w: 420, h: null },
};

export const MIN_W = 240;
export const MIN_H = 160;

const storageKey = (layout: PopoverLayout) => `pca:annotation-popover:${layout}`;

function currentLayout(): PopoverLayout {
  if (window.matchMedia(PHONE).matches) return 'phone';
  return window.matchMedia(DESKTOP).matches ? 'desktop' : 'tablet';
}

function readSize(layout: PopoverLayout): PopoverSize {
  try {
    const raw = localStorage.getItem(storageKey(layout));
    if (!raw) return DEFAULT_SIZE[layout];
    const v = JSON.parse(raw) as Partial<PopoverSize>;
    return {
      w: typeof v.w === 'number' && v.w >= MIN_W ? v.w : DEFAULT_SIZE[layout].w,
      h: typeof v.h === 'number' && v.h >= MIN_H ? v.h : null,
    };
  } catch {
    return DEFAULT_SIZE[layout];
  }
}

/**
 * Popover layout for the current viewport and the size the user gave it, remembered
 * per layout in this browser (a per-viewer convenience, so localStorage is enough).
 */
export function usePopoverSize() {
  const [layout, setLayout] = useState(currentLayout);
  const [size, setSizeState] = useState(() => readSize(layout));

  useEffect(() => {
    const update = () => {
      const next = currentLayout();
      setLayout(next);
      setSizeState(readSize(next));
    };
    const queries = [window.matchMedia(PHONE), window.matchMedia(DESKTOP)];
    for (const q of queries) q.addEventListener('change', update);
    return () => {
      for (const q of queries) q.removeEventListener('change', update);
    };
  }, []);

  const setSize = useCallback(
    (next: PopoverSize, persist = true) => {
      setSizeState(next);
      if (!persist) return;
      try {
        localStorage.setItem(storageKey(layout), JSON.stringify(next));
      } catch {
        // Storage unavailable (private mode): the size just isn't remembered.
      }
    },
    [layout],
  );

  const reset = useCallback(() => {
    setSizeState(DEFAULT_SIZE[layout]);
    try {
      localStorage.removeItem(storageKey(layout));
    } catch {
      // Ignore.
    }
  }, [layout]);

  return { layout, size, setSize, reset };
}
