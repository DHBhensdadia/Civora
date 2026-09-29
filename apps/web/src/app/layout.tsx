import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { JetBrains_Mono, Manrope } from 'next/font/google';

import { LanguagePicker } from '@/components/language-picker';
import { SiteNav } from '@/components/site-nav';
import { LANGUAGE_COOKIE, languageFrom, offeredLanguages } from '@/lib/language';
import { SESSION_COOKIE, parseSession } from '@/lib/session';

import './globals.css';

/*
 * The two families, self-hosted at build time by Next rather than fetched from a
 * font CDN at runtime, which is what keeps the platform working in a room with
 * bad wifi. Both are supplied as CSS variables and consumed by the token layer in
 * `globals.css` — which falls back to a system stack inside `var()`, so a build
 * that cannot reach the font host still renders in a real interface font rather
 * than in the browser's default serif.
 *
 * A grotesque for the interface and a mono for the labels: the mono is what makes
 * an eyebrow read as instrumentation rather than as small print.
 */
const sans = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono-code', display: 'swap' });

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
 * call, and a request with no cookie is the national control room — which is what
 * makes the demonstration work with nothing signed in.
 *
 * Three things about this file are load-bearing rather than cosmetic:
 *
 *  - **The header is sticky**, so the simulated-data badge is inside the viewport
 *    at every scroll offset on every surface. The labelling sweep asserts that
 *    from outside, and a disclosure a reader has to scroll back up to find is not
 *    a disclosure.
 *  - **The disclosure sentence is printed exactly once in the whole application**,
 *    here. A second copy would be a second thing to keep true, and the sweep
 *    fails on two.
 *  - **Prose is narrow, instruments are wide.** The shell is `--container-shell`
 *    for the navigation and the surfaces, and the individual panels cap their own
 *    prose at the measure. Nothing here forces a paragraph to a full-width line.
 */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const jar = await cookies();
  const session = parseSession(jar.get(SESSION_COOKIE)?.value);
  const language = languageFrom(jar.get(LANGUAGE_COOKIE)?.value);

  return (
    <html className={`${sans.variable} ${mono.variable}`} lang={language}>
      <body className="min-h-screen antialiased">
        <a
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-instrument focus:bg-ink-800 focus:px-3 focus:py-2 focus:text-sm"
          href="#content"
        >
          Skip to content
        </a>

        <header className="sticky top-0 z-30 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
          <div className="mx-auto flex max-w-shell flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Link className="flex min-h-11 items-center gap-2" href="/">
                <span className="text-sm font-semibold tracking-tight">Civora</span>
                <span className="hidden font-mono text-eyebrow text-fg-subtle uppercase sm:inline">
                  health supply-chain resilience
                </span>
              </Link>
              {/*
               * The disclosure travels with the shell, not with the home page.
               * A judge who deep-links to a surface must meet it there: a page
               * that renders a national stock position without saying the position
               * is generated is the one way this demonstration could mislead.
               */}
              <span
                data-testid="simulated-badge"
                className="inline-flex min-h-7 items-center rounded-full border border-signal-watch/50 bg-signal-watch/10 px-2.5 font-mono text-eyebrow text-signal-watch uppercase"
              >
                simulated data
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {/* The acting role is named rather than hidden in a menu: the
                  demonstration switches personas on stage, and a person who has
                  just been refused deserves to know who the platform thinks they
                  are. */}
              <span
                data-testid="active-role"
                className="inline-flex items-center rounded-full border border-ink-600 px-3 py-1 font-mono text-xs text-fg-muted"
              >
                {session.label} · {session.role.replace('_', ' ')}
              </span>
              <LanguagePicker current={language} offered={offeredLanguages()} />
            </div>
          </div>
        </header>

        <div className="mx-auto flex max-w-shell flex-col gap-8 px-5 py-8 lg:flex-row lg:gap-10 lg:py-12">
          <aside className="lg:w-56 lg:shrink-0">
            <div className="lg:sticky lg:top-24">
              <SiteNav session={session} />
            </div>
          </aside>
          <main className="min-w-0 flex-1" id="content">
            {children}
          </main>
        </div>

        <footer className="border-t border-ink-700 px-5 py-10">
          <div className="mx-auto flex max-w-shell flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-eyebrow text-fg-subtle uppercase">
              <span>Licensed under Apache-2.0</span>
              <span>All figures generated from a seeded world</span>
            </div>
            {/*
             * Exactly once, in the shell, so no surface can be reached without
             * it. `e2e/labelling.spec.ts` asserts the count and the wording.
             */}
            <p data-testid="simulation-disclosure" className="max-w-measure text-xs text-fg-subtle">
              All data the platform shows is simulated. Nothing here is a real stock position and
              this is not a deployed federation.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
