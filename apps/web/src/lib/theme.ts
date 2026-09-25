import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemePreference = 'system' | 'light' | 'dark';

interface ThemeState {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist((set) => ({ preference: 'system', setPreference: (preference) => set({ preference }) }), {
    name: 'pdfclaudeassistant-theme',
  }),
);

/** Applies the theme preference to <html data-theme>, following the OS when set to system. */
export function useApplyTheme(): void {
  const preference = useThemeStore((s) => s.preference);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = preference === 'dark' || (preference === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preference]);
}
