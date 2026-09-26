import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';

import { SiteNav } from '@/components/site-nav';
import { LANGUAGE_COOKIE, languageFrom } from '@/lib/language';
import { SESSION_COOKIE, parseSession } from '@/lib/session';

import './globals.css';

export const metadata: Metadata = {
  title: 'Civora — health supply-chain resilience',
  description:
    'A federated AI platform for health resource and supply-chain planning across the primary health centre network.',
};

/**
 * The shell every surface is drawn in.
 *
 * The header reads the session here rather than in each page, because the
 * navigation is a property of the shell: a surface cannot be offered to a role
 * the header would not name. The read is the same `parseSession` the API routes
 * call, and a request with no cookie is the national control room — which is
 * what makes the demonstration work with nothing signed in.
 */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const jar = await cookies();
  const session = parseSession(jar.get(SESSION_COOKIE)?.value);
  const language = languageFrom(jar.get(LANGUAGE_COOKIE)?.value);

  return (
    <html lang={language}>
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <header className="border-b border-slate-800/80 px-6 py-4">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-sm tracking-wide text-slate-400">
              Civora · health supply-chain resilience
            </span>
            <SiteNav session={session} language={language} />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
