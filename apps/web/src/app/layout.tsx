import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { JetBrains_Mono, Manrope } from 'next/font/google';

import { LanguagePicker } from '@/components/language-picker';
import { SiteNav } from '@/components/site-nav';
import { buildIdentity } from '@/lib/build-info';
import { LANGUAGE_COOKIE, languageFrom, offeredLanguages } from '@/lib/language';
import { getLiveStore } from '@/lib/live-store';
import { navigationFor } from '@/lib/navigation';
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
 * A grotesque for the interface and a mono for the things that are literally
 * machine text: digests, seeds, fingerprints, commands and code. The mono is
 * **no longer a label style** — a mono uppercase tracked eyebrow is the
 * instrument idiom V2 was built on and the one the owner rejected, so a label is
 * now the body family in sentence case. What the mono is kept for is the two
 * places the plan allows it: a column of tabular figures, and `audit`'s digests.
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
 * Four things about this file are load-bearing rather than cosmetic:
 *
 *  - **The disclosure is a fixed `--color-sun` bar at the bottom edge**, carrying
 *    the badge and the sentence together. The header used to hold the badge and
 *    the footer the sentence, which meant the two halves of one statement were at
 *    opposite ends of a twelve-panel page; the bar is the reference's own move —
 *    its announcement bar is the only saturated thing on the site and it sits at
 *    the edge rather than in the middle. **The badge stays visible without
 *    scrolling on every surface**, which the labelling sweep asserts from outside
 *    with `toBeInViewport()`, and a disclosure a reader has to scroll to find is
 *    not a disclosure.
 *  - **The disclosure sentence is printed exactly once in the whole application**,
 *    here. A second copy would be a second thing to keep true, and the sweep
 *    fails on two.
 *  - **Nothing may hide behind the bar.** The footer carries the bar's height
 *    again as bottom padding, so the last row of text is never under it — and the
 *    browser suite, which scrolls to a control before clicking it, is the evidence
 *    that a control is never swallowed either.
 *  - **Prose is narrow, instruments are wide.** The shell is `--container-shell`
 *    for the navigation and the surfaces, and the individual panels cap their own
 *    prose at the measure. Nothing here forces a paragraph to a full-width line —
 *    except the disclosure sentence, which is deliberately one line across the
 *    bar rather than a column.
 *
 * The wordmark is the reference's real-letterform move at the scale a sticky bar
 * can carry: display weight (400, which is what its own `h1` uses) at `text-2xl`,
 * not the 44px display step, because the bar would then be 76px tall on all
 * thirteen surfaces and the bottom edge already belongs to the disclosure. The
 * **display-scale watermark lives in the footer**, cropped by its bottom edge,
 * where the reference keeps its own.
 *
 * **The footer is two rows and one hairline.** The reference's footer is a
 * sitemap and a line of small print rather than a stack of blocks, and the two
 * rows here are its own: the routes, then the build's identity — the version, the
 * commit it was given, the fingerprint of the world it is serving and the word
 * for what that world is — with the honesty statements in the same row, because
 * that is where a reader looks for them. The fingerprint is read from the store
 * rather than written here: a digest copied into the source is a second copy of a
 * fact that drifts, and this file exists to keep one copy of each.
 *
 * **The watermark is a mark, not text.** It is `aria-hidden`, it carries no
 * information a reader acts on, and it is drawn at 8% ink — which is a contrast
 * ratio far below AA and therefore has to be *declared* as decoration rather than
 * quietly rendered: the rendered audit reads a text leaf inside `[data-decorative]`
 * as a mark and says how many it skipped. Copying the reference's watermark
 * without that declaration would be a contrast failure in every report.
 */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const jar = await cookies();
  const session = parseSession(jar.get(SESSION_COOKIE)?.value);
  const language = languageFrom(jar.get(LANGUAGE_COOKIE)?.value);
  const sections = navigationFor(session);
  /*
   * The world's own fingerprint, for the identity row.
   *
   * This is the one read in the shell that reaches the store. Every surface but
   * the two intake pages already reads it, and it is built once per process and
   * shared, so the shell is not adding a build to any page that did not already
   * pay for one — and the alternative, a digest written into this file, is the
   * second copy of a fact that `RUN_STATE.md` has already had to correct once.
   */
  const store = await getLiveStore();
  const identity = buildIdentity();

  return (
    <html className={`${sans.variable} ${mono.variable}`} lang={language}>
      <body className="min-h-screen antialiased">
        <a
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-card focus:bg-paper-sunken focus:px-3 focus:py-2 focus:text-sm"
          href="#content"
        >
          Skip to content
        </a>

        <header className="sticky top-0 z-30 border-b border-hairline bg-paper/90 backdrop-blur">
          <div className="mx-auto flex max-w-shell flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Link className="flex min-h-11 items-center gap-3" href="/">
                <span className="text-2xl font-normal">Civora</span>
                <span className="hidden text-eyebrow text-ink-subtle sm:inline">
                  health supply-chain resilience
                </span>
              </Link>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {/* The acting role is named rather than hidden in a menu: the
                  demonstration switches personas on stage, and a person who has
                  just been refused deserves to know who the platform thinks they
                  are. */}
              <span
                data-testid="active-role"
                className="inline-flex items-center rounded-control bg-paper-sunken px-3 py-1 text-xs text-ink-muted"
              >
                {session.label} · {session.role.replace('_', ' ')}
              </span>
              <LanguagePicker current={language} offered={offeredLanguages()} />
            </div>
          </div>
        </header>

        <div className="mx-auto flex max-w-shell flex-col gap-8 px-5 py-8 lg:flex-row lg:gap-10 lg:py-12">
          <aside className="lg:w-64 lg:shrink-0">
            {/*
             * The floating bar.
             *
             * The reference's navigation is a raised 12px-radius pill on the grey
             * wash with a soft shadow rather than a full-width bordered strip, and
             * this is that move applied to thirteen links in four groups: the
             * groups stay, because seven links fit one row and these do not. The
             * wrapper is what sticks, so the plate itself never scrolls away mid
             * surface.
             */}
            <div className="lg:sticky lg:top-24">
              <SiteNav session={session} />
            </div>
          </aside>
          <main className="min-w-0 flex-1" id="content">
            {children}
          </main>
        </div>

        {/* The bar is fixed, so the footer reserves its height and then some: at
            `sm` and above the bar measures about 59px, and below it the sentence
            wraps further, so the narrow layout reserves more. */}
        <footer className="relative overflow-hidden border-t border-hairline px-5 pt-8 pb-32 sm:pb-24">
          <div className="relative mx-auto max-w-shell">
            {/*
             * The signature, and the arithmetic that sizes it.
             *
             * The reference crops a giant wordmark against the bottom of its
             * footer; this is that mark at the product's own display weight and
             * tracking. `overflow-hidden` on the footer is what crops it — a mark
             * that ended neatly above the edge would be a heading rather than a
             * signature — and the size is chosen from the band that is actually
             * visible rather than by eye:
             *
             *  - the footer is **213px** tall at 1440, of which the fixed
             *    disclosure bar covers the last **59px**, so the band a mark can
             *    occupy is **154px**;
             *  - Manrope's cap height is about **0.72em**, so 154px of band is a
             *    ceiling of about **214px** of type — and **12.5rem (200px)**
             *    leaves the feet a few pixels behind the bar, which is the crop;
             *  - anchoring the top rather than the bottom is what keeps that true
             *    at both breakpoints: the container's top is `pt-8` on every
             *    screen, while the space below it is `pb-32`/`pb-24` against a
             *    91px/59px bar — two pairs of numbers that only accidentally
             *    agree, and the mark was hanging below the bar on a phone before
             *    it was measured.
             */}
            <span
              aria-hidden="true"
              data-decorative="wordmark"
              className="pointer-events-none absolute -top-4 left-0 text-[clamp(3.5rem,20vw,12.5rem)] leading-none font-normal tracking-[-0.05em] text-ink/[0.08] select-none"
            >
              Civora
            </span>

            <div className="relative flex flex-col gap-5">
              {/*
               * Row one: the sitemap.
               *
               * The same offer rule as the sidebar, from the same list, so a
               * surface a role is not offered is not linked here either — the
               * audit's own assertion that a refused link must not exist reads
               * the whole page, not one landmark. Each link keeps the 44px floor
               * the rest of the product holds: a footer row is still a row of
               * controls, and a 19px link is a link a thumb misses.
               */}
              <nav
                aria-label="Every surface"
                className="flex flex-wrap items-center justify-start gap-x-5 text-xs text-ink-muted sm:justify-between"
              >
                {sections.map((section) => (
                  <Link
                    key={section.href}
                    className="inline-flex min-h-11 items-center rounded-control px-1 hover:text-ink"
                    href={section.href}
                  >
                    {section.label}
                  </Link>
                ))}
              </nav>

              {/*
               * Row two: what this build is.
               *
               * Divided into the two questions a reader has — *which build am I
               * reading* and *may I trust it* — and distributed across the row so
               * the identity sits under the routes and the honesty under the
               * white space, which is where the eye goes looking for it. The
               * fingerprint is the only mono in the shell: it is machine text,
               * which is exactly what the one place the mono is kept for is.
               */}
              <div className="flex flex-wrap items-center justify-start gap-x-6 gap-y-1 text-xs text-ink-subtle sm:justify-between">
                <span
                  data-testid="build-identity"
                  className="flex flex-wrap items-center gap-x-3 gap-y-1"
                >
                  <span>Civora v{identity.version}</span>
                  <span>commit {identity.commitLabel}</span>
                  <span className="font-mono">dataset {store.info.fingerprint}</span>
                </span>
                <span
                  data-testid="footer-honesty"
                  className="flex flex-wrap items-center gap-x-3 gap-y-1"
                >
                  <span>simulated data</span>
                  <span>figures generated from a seeded world</span>
                  <span>every layer names the adapter it came from</span>
                  <span>Apache-2.0</span>
                </span>
              </div>
            </div>
          </div>
        </footer>

        {/*
         * The disclosure, at the bottom edge, in the one saturated colour on the
         * page — the reference's announcement bar, carrying the fact a reader must
         * not miss. It is never dismissible, it is never below the fold, and its
         * text is ink on the pastel rather than the pastel as text.
         *
         * It is `min-h-12` because the reference measures its bar at 48px — and it
         * **grows past it**, because the sentence keeps the same measure as every
         * other paragraph. That was a decision rather than an oversight: letting it
         * run the bar's full width made it the widest paragraph in the product at
         * **104 characters**, which is exactly the criterion this phase exists to
         * have met, and eleven pixels of bar height is the cheaper price. It is
         * allowed to grow further on a narrow screen rather than truncate the
         * sentence: a disclosure that fits by cutting a clause is not a disclosure.
         */}
        <div className="fixed inset-x-0 bottom-0 z-40 bg-sun">
          <div className="mx-auto flex min-h-12 max-w-shell flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5">
            <span
              data-testid="simulated-badge"
              className="inline-flex min-h-7 shrink-0 items-center rounded-control bg-ink px-2.5 text-eyebrow text-paper"
            >
              simulated data
            </span>
            {/*
             * Exactly once, in the shell, so no surface can be reached without it.
             * `e2e/labelling.spec.ts` asserts the count and the wording. It carries
             * no measure override: the same `p` cap that makes a surface's prose
             * readable caps this sentence too, which is what keeps the widest
             * paragraph in the product inside its own target.
             */}
            <p data-testid="simulation-disclosure" className="text-xs text-ink">
              All data the platform shows is simulated. Nothing here is a real stock position and
              this is not a deployed federation.
            </p>
          </div>
        </div>
      </body>
    </html>
  );
}
