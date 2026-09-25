import type { ReactNode } from 'react';

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-8 lg:px-10 lg:py-12">
      <h1 className="mb-8 font-serif text-3xl tracking-tight">{title}</h1>
      {children}
    </div>
  );
}
