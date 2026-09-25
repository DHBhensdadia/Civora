import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { SiteNav } from '@/components/site-nav';

import './globals.css';

export const metadata: Metadata = {
  title: 'Civora — health supply-chain resilience',
  description:
    'A federated AI platform for health resource and supply-chain planning across the primary health centre network.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <header className="border-b border-slate-800/80 px-6 py-4">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-sm tracking-wide text-slate-400">
              Civora · health supply-chain resilience
            </span>
            <SiteNav />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
