import Link from 'next/link';

import { PageHeader } from '@/components/page-header';
import { Eyebrow, StatCard, formatCount } from '@/components/ui';
import { getEnv } from '@/env';
import { MODULES } from '@/lib/modules';
import { APP_VERSION } from '@/lib/version';
import { getProviders } from '@/providers';

export const dynamic = 'force-dynamic';

/**
 * The platform's front door.
 *
 * It is a status page and it says so. The one thing a reader has to leave with is
 * the sentence in the disclosure: the loop closes end to end in this build and no
 * live deployment exists. That statement is the first thing under the hero, at
 * the top of the page rather than in a corner of it.
 *
 * **The composition is the reference's, and it is a decision rather than a
 * default.** The title and its lead sit side by side in a two-column header — the
 * measured Apoha grid, `660px 660px` at `gap: 0` — instead of being stacked into
 * a column that ends before the page has started, and the sections below are read
 * at the reference's own rhythm rather than packed against each other.
 *
 * **The statement block is no longer tinted, and that is the fix rather than a
 * loss.** It used to carry a 30% sun plate, which meant this page had *two*
 * pale-yellow moments in one glance — this block and the fixed disclosure bar at
 * the bottom edge — and neither was loud. The reference keeps exactly one
 * saturated element per view and puts it at the edge; the bar is ours, and the
 * sentence keeps its emphasis from position and type instead.
 *
 * Everything else is three groups read in order: what the process is running on
 * (adapters), what it can do (modules), and where to look next (the footer). The
 * navigation beside it is the shell's, not this page's.
 */

/**
 * The module row's marks.
 *
 * One faint wash per card, cycled across the row, which is the reference's own
 * move: three cards, each carrying a different pastel, so the row reads as three
 * different things before a word of it is read. Five modules and three pastels
 * means the cycle wraps, which is honest — these are marks, not categories, and
 * nothing in the product reads a card's colour as a meaning.
 */
const MODULE_WASHES = ['bg-mint/25', 'bg-sun/25', 'bg-coral/25'] as const;

/**
 * The mark's fill, at the same depths the status labels use.
 *
 * They were full pastels first, and the audit caught the one that mattered: the
 * monogram is a 14.4px letterform in ink, and ink on **full coral** measures
 * **4.46:1** — under AA, on a decorative element the source never looks wrong in.
 * Mint and sun were comfortable at full strength; coral is the hue that is not,
 * which is the same reason the label recipe holds all three at partial opacity.
 */
const MODULE_MARKS = ['bg-mint/40', 'bg-sun/50', 'bg-coral/45'] as const;

export default async function HomePage() {
  const env = getEnv();
  const providers = getProviders();
  const data = await providers.data.health();

  const adapters = [
    { port: 'Data', kind: providers.data.kind },
    { port: 'Identity', kind: providers.auth.kind },
    { port: 'Reasoning', kind: providers.reasoning.kind },
  ];

  return (
    <div className="flex flex-col gap-20 lg:gap-24">
      <PageHeader
        label="Health supply-chain resilience"
        scale="hero"
        layout="split"
        title={env.appName}
      >
        <p className="text-lead text-ink-muted">
          A federated platform for health resource and supply-chain planning across the primary
          health centre network.
        </p>
      </PageHeader>
      {/* The statement a reader must not miss, and it is positioned to be read
          rather than tinted to be noticed — see the note above. */}{' '}
      <section
        aria-labelledby="status-heading"
        className="rounded-card bg-paper-raised p-6 sm:p-10"
      >
        {/*
         * The same two-column grid as the header, one level down: the sentence
         * that matters on the left, the prose that supports it on the right. It
         * was a single left-aligned column in a full-width plate, which left half
         * the plate empty and made the plate, rather than the sentence, the thing
         * a reader saw.
         */}
        <div className="grid gap-y-6 lg:grid-cols-2 lg:gap-x-0">
          <h2 id="status-heading" className="text-2xl text-balance text-ink">
            The platform proposes redistribution — and executes none of it
          </h2>
          <div className="flex flex-col gap-4 text-base text-ink-muted">
            <p>
              The loop closes end to end in this build — capture, visibility, forecast, alert, a
              constraint-checked transfer proposal, a person&rsquo;s decision and the audit trail
              behind it — but{' '}
              <strong className="font-medium text-ink">no live deployment exists yet</strong>: the
              deployment is scripted and the demonstration runs locally. A facility can record
              stock, beds, attendance and footfall{' '}
              <Link className="text-ink underline underline-offset-4" href="/capture">
                offline
              </Link>
              ; the platform accepts it idempotently and scoped to the facility that sent it; and a
              district officer can see{' '}
              <Link className="text-ink underline underline-offset-4" href="/visibility">
                what the district can see
              </Link>{' '}
              — including, explicitly, the facilities it cannot.
            </p>
            <p>
              Paper is still how most of it is recorded, so a register can be{' '}
              <Link className="text-ink underline underline-offset-4" href="/vision">
                photographed
              </Link>{' '}
              and a stock, bed or attendance update can be{' '}
              <Link className="text-ink underline underline-offset-4" href="/voice">
                spoken
              </Link>
              . Neither becomes a record on the platform&rsquo;s own judgement: a reading is checked
              against the catalogue and the ledger&rsquo;s rules, a spoken update is shown back to
              the person who spoke it, and what cannot be settled waits for a human instead of being
              guessed.
            </p>
            <p>
              Setu shows what the optimiser proposes under hard safety constraints, the independent
              validator&rsquo;s verdict on every proposal, and what each transfer is expected to buy
              — with the assumptions printed beside the figure — and an officer approves or rejects
              it with a reason that is recorded in a hash-chained trail. Nothing there executes a
              transfer, and that is deliberate. Samvad federates a model across the states without
              moving a record: what crosses the boundary is a clipped parameter update, a count and
              a loss, and the noise that buys the privacy guarantee is priced by a Rényi accountant.
              The substrate a real deployment would run on is cited rather than implied —{' '}
              <Link className="text-ink underline underline-offset-4" href="/redistribution">
                the workbench
              </Link>{' '}
              and the{' '}
              <Link className="text-ink underline underline-offset-4" href="/federation">
                federation console
              </Link>{' '}
              are where both are shown.
            </p>
          </div>
        </div>
      </section>
      <section aria-labelledby="adapters-heading" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Eyebrow>Sensing plane</Eyebrow>
          <h2 id="adapters-heading" className="text-2xl">
            Active adapters
          </h2>
          <p className="max-w-measure text-sm text-ink-muted">
            Every external boundary is a port. With no cloud credentials configured the process runs
            against local adapters, which is how the platform stays testable and demoable offline.
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-3">
          {adapters.map((adapter) => (
            <StatCard key={adapter.port} label={adapter.port} value={adapter.kind} />
          ))}
        </div>
        <p className="text-sm text-ink-subtle">
          Data adapter health:{' '}
          <span className={data.ok ? 'text-ink' : 'text-ink font-medium'}>
            {data.ok ? 'reachable' : 'unreachable'}
          </span>
          {data.detail === undefined ? '' : ` — ${data.detail}`}
        </p>
      </section>
      <section aria-labelledby="modules-heading" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Eyebrow>Capabilities</Eyebrow>
          <h2 id="modules-heading" className="text-2xl">
            Modules
          </h2>
          <p className="max-w-measure text-sm text-ink-muted">
            Five capabilities, and a status for each, in the platform&rsquo;s own words rather than
            a percentage. All five are present; none is described as more than a command measured,
            and the managed federation substrate is named as documented rather than built. Each card
            opens the surface that shows it at work.
          </p>
        </div>
        {/*
         * The three-column row, with the reference's own card grid inside each
         * card: a 40px mark, the label, and an 18px arrow — `40px 1fr 18px`, gap
         * 10px. The whole card is the link, so the arrow is an affordance rather
         * than a decoration, and the mark is a monogram because the platform ships
         * no icon set and inventing one is not this phase's work.
         */}
        <ul className="grid gap-5 lg:grid-cols-3">
          {MODULES.map((module, index) => (
            <li key={module.name} className="h-full">
              <Link
                className={`group grid h-full grid-cols-[40px_1fr_18px] items-start gap-2.5 rounded-card p-5 transition-colors duration-200 hover:bg-paper-sunken ${MODULE_WASHES[index % MODULE_WASHES.length]}`}
                href={module.href}
              >
                <span
                  aria-hidden="true"
                  className={`flex size-10 items-center justify-center rounded-control text-eyebrow font-medium text-ink ${MODULE_MARKS[index % MODULE_MARKS.length]}`}
                >
                  {module.name.slice(0, 1)}
                </span>
                <span className="flex flex-col gap-1.5">
                  <span className="text-eyebrow text-ink-subtle">{module.meaning}</span>
                  <h3 className="text-xl text-ink">{module.name}</h3>
                  <span className="text-sm text-ink-muted">{module.responsibility}</span>
                  <span
                    className={`mt-2 border-t border-hairline pt-3 text-sm ${
                      module.status === 'not implemented' ? 'text-ink-subtle' : 'text-ink'
                    }`}
                  >
                    {module.status}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className="justify-self-end text-ink-subtle transition-transform duration-200 group-hover:translate-x-0.5"
                >
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hairline pt-6 text-eyebrow text-ink-subtle">
        <span>Version {APP_VERSION}</span>
        <span>{formatCount(MODULES.length)} modules</span>
        <Link
          className="inline-flex min-h-11 items-center text-accent transition-colors duration-150 hover:text-ink"
          href="/healthz"
        >
          Health check
        </Link>
        <Link
          className="inline-flex min-h-11 items-center text-accent transition-colors duration-150 hover:text-ink"
          href="/readyz"
        >
          Readiness
        </Link>
        <Link
          className="inline-flex min-h-11 items-center text-accent transition-colors duration-150 hover:text-ink"
          href="/provenance"
        >
          Data provenance
        </Link>
      </footer>
    </div>
  );
}
