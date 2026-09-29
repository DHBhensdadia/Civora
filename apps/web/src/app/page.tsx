import Link from 'next/link';

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
 * the sentence in the banner: the loop closes end to end in this build and no
 * live deployment exists. That banner is the only element on the page carrying a
 * full tint, deliberately — a page that spends its loudest treatment on a
 * heading has nothing left to say the thing that matters.
 *
 * Everything else is three groups read in order: what the process is running on
 * (adapters), what it can do (modules), and where to look next (the footer). The
 * navigation beside it is the shell's, not this page's.
 */
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
    <div className="flex flex-col gap-16">
      <header className="flex flex-col gap-5">
        <Eyebrow tone="accent">Health supply-chain resilience</Eyebrow>
        <h1 className="text-hero text-balance">{env.appName}</h1>
        <p className="max-w-measure text-lg text-fg-muted">
          A federated platform for health resource and supply-chain planning across the primary
          health centre network.
        </p>
      </header>

      {/*
       * The disclosure. Its heading is the sentence a reader must not miss, and
       * it keeps the only full tint in the interface for that reason.
       */}
      <section
        aria-labelledby="status-heading"
        className="rounded-instrument border border-signal-watch/40 bg-signal-watch/10 p-6 sm:p-8"
      >
        <h2 id="status-heading" className="max-w-measure text-2xl text-balance text-signal-watch">
          The platform proposes redistribution — and executes none of it
        </h2>
        <div className="mt-4 flex max-w-measure flex-col gap-4 text-base text-signal-watch/90">
          <p>
            The loop closes end to end in this build — capture, visibility, forecast, alert, a
            constraint-checked transfer proposal, a person&rsquo;s decision and the audit trail
            behind it — but{' '}
            <strong className="font-medium text-signal-watch">no live deployment exists yet</strong>
            : the deployment is scripted and the demonstration runs locally. A facility can record
            stock, beds, attendance and footfall{' '}
            <Link className="text-signal-watch underline underline-offset-4" href="/capture">
              offline
            </Link>
            ; the platform accepts it idempotently and scoped to the facility that sent it; and a
            district officer can see{' '}
            <Link className="text-signal-watch underline underline-offset-4" href="/visibility">
              what the district can see
            </Link>{' '}
            — including, explicitly, the facilities it cannot.
          </p>
          <p>
            Paper is still how most of it is recorded, so a register can be{' '}
            <Link className="text-signal-watch underline underline-offset-4" href="/vision">
              photographed
            </Link>{' '}
            and a stock, bed or attendance update can be{' '}
            <Link className="text-signal-watch underline underline-offset-4" href="/voice">
              spoken
            </Link>
            . Neither becomes a record on the platform&rsquo;s own judgement: a reading is checked
            against the catalogue and the ledger&rsquo;s rules, a spoken update is shown back to the
            person who spoke it, and what cannot be settled waits for a human instead of being
            guessed.
          </p>
          <p>
            Setu shows what the optimiser proposes under hard safety constraints, the independent
            validator&rsquo;s verdict on every proposal, and what each transfer is expected to buy —
            with the assumptions printed beside the figure — and an officer approves or rejects it
            with a reason that is recorded in a hash-chained trail. Nothing there executes a
            transfer, and that is deliberate. Samvad federates a model across the states without
            moving a record: what crosses the boundary is a clipped parameter update, a count and a
            loss, and the noise that buys the privacy guarantee is priced by a Rényi accountant. The
            substrate a real deployment would run on is cited rather than implied —{' '}
            <Link className="text-signal-watch underline underline-offset-4" href="/redistribution">
              the workbench
            </Link>{' '}
            and the{' '}
            <Link className="text-signal-watch underline underline-offset-4" href="/federation">
              federation console
            </Link>{' '}
            are where both are shown.
          </p>
        </div>
      </section>

      <section aria-labelledby="adapters-heading" className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Eyebrow>Sensing plane</Eyebrow>
          <h2 id="adapters-heading" className="text-2xl">
            Active adapters
          </h2>
          <p className="max-w-measure text-sm text-fg-muted">
            Every external boundary is a port. With no cloud credentials configured the process runs
            against local adapters, which is how the platform stays testable and demoable offline.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {adapters.map((adapter) => (
            <StatCard key={adapter.port} label={adapter.port} value={adapter.kind} />
          ))}
        </div>
        <p className="text-sm text-fg-subtle">
          Data adapter health:{' '}
          <span className={data.ok ? 'text-signal-ok' : 'text-signal-critical'}>
            {data.ok ? 'reachable' : 'unreachable'}
          </span>
          {data.detail === undefined ? '' : ` — ${data.detail}`}
        </p>
      </section>

      <section aria-labelledby="modules-heading" className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Eyebrow>Capabilities</Eyebrow>
          <h2 id="modules-heading" className="text-2xl">
            Modules
          </h2>
          <p className="max-w-measure text-sm text-fg-muted">
            Five capabilities, and a status for each, in the platform&rsquo;s own words rather than
            a percentage. All five are present; none is described as more than a command measured,
            and the managed federation substrate is named as documented rather than built.
          </p>
        </div>
        <ul className="grid gap-4 lg:grid-cols-2">
          {MODULES.map((module) => (
            <li
              key={module.name}
              className="flex flex-col gap-3 rounded-instrument border border-ink-700 bg-ink-900 p-5"
            >
              <Eyebrow>{module.meaning}</Eyebrow>
              <h3 className="text-xl">{module.name}</h3>
              <p className="max-w-measure text-sm text-fg-muted">{module.responsibility}</p>
              <p
                className={`max-w-measure border-t border-ink-700 pt-3 text-sm ${
                  module.status === 'not implemented' ? 'text-fg-subtle' : 'text-signal-ok'
                }`}
              >
                {module.status}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-700 pt-6 font-mono text-eyebrow text-fg-subtle uppercase">
        <span>Version {APP_VERSION}</span>
        <span>{formatCount(MODULES.length)} modules</span>
        <Link
          className="inline-flex min-h-11 items-center text-accent transition-colors duration-150 hover:text-fg"
          href="/healthz"
        >
          Health check
        </Link>
        <Link
          className="inline-flex min-h-11 items-center text-accent transition-colors duration-150 hover:text-fg"
          href="/readyz"
        >
          Readiness
        </Link>
        <Link
          className="inline-flex min-h-11 items-center text-accent transition-colors duration-150 hover:text-fg"
          href="/provenance"
        >
          Data provenance
        </Link>
      </footer>
    </div>
  );
}
