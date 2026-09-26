import type { ReactNode } from 'react';
import { TimerToggle } from '../features/timer/TimerToggle';

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-8 lg:px-10 lg:py-12">
      <div className="mb-8 flex items-start gap-2">
        <h1 className="flex-1 font-serif text-3xl tracking-tight">{title}</h1>
        {/* Phones have no sidebar entry for the study timer. */}
        <TimerToggle className="lg:hidden" />
      </div>
      {children}
    </div>
  );
}
