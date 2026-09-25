import Link from 'next/link';

import { getEnv } from '@/env';
import { MODULES } from '@/lib/modules';
import { APP_VERSION } from '@/lib/version';
import { getProviders } from '@/providers';

export const dynamic = 'force-dynamic';

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
    <main className="mx-auto flex max-w-4xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-medium tracking-widest text-sky-400 uppercase">
          Health supply-chain resilience
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">{env.appName}</h1>
        <p className="max-w-2xl text-lg text-slate-300">
          A federated platform for health resource and supply-chain planning across the primary
          health centre network.
        </p>
      </header>

      <section
        aria-labelledby="status-heading"
        className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-6"
      >
        <h2 id="status-heading" className="text-lg font-semibold text-amber-200">
          The platform proposes redistribution — and executes none of it
        </h2>
        <p className="mt-2 text-amber-100/90">
          What works today is the half that everything else depends on. A facility can record stock,
          beds, attendance and footfall{' '}
          <Link className="underline underline-offset-4" href="/capture">
            offline
          </Link>
          ; the platform accepts it idempotently and scoped to the facility that sent it; and a
          district officer can see{' '}
          <Link className="underline underline-offset-4" href="/visibility">
            what the district can see
          </Link>{' '}
          — including, explicitly, the facilities it cannot. The dataset behind all of it is
          browsable in the{' '}
          <Link className="underline underline-offset-4" href="/dataset">
            dataset inspector
          </Link>
          .
        </p>
        <p className="mt-2 text-amber-100/90">
          Paper is still how most of it is recorded, so a register can be{' '}
          <Link className="underline underline-offset-4" href="/vision">
            photographed
          </Link>{' '}
          and a stock, bed or attendance update can be{' '}
          <Link className="underline underline-offset-4" href="/voice">
            spoken
          </Link>
          . Neither becomes a record on the platform&rsquo;s own judgement: a reading is checked
          against the catalogue and the ledger&rsquo;s rules, a spoken update is shown back to the
          person who spoke it, and what cannot be settled waits for a human instead of being
          guessed.
        </p>
        <p className="mt-2 text-amber-100/90">
          Forecasts and risk scores are computed from that same generated world, and a district
          officer can work the ranked list and the alert inbox on the{' '}
          <Link className="underline underline-offset-4" href="/intelligence">
            intelligence surface
          </Link>
          . Setu goes one step further: the{' '}
          <Link className="underline underline-offset-4" href="/redistribution">
            redistribution workbench
          </Link>{' '}
          shows what the optimiser proposes under hard safety constraints, the independent
          validator&rsquo;s verdict on every proposal, and what each transfer is expected to buy —
          with the assumptions printed beside the figure — and an officer approves or rejects it
          with a reason that is recorded in a hash-chained trail. Nothing there executes a transfer,
          and that is deliberate.
        </p>
        <p className="mt-2 text-sm text-amber-100/70">
          All data the platform shows is simulated. Nothing here is a real stock position and this
          is not a deployed federation.
        </p>
      </section>

      <section aria-labelledby="adapters-heading" className="flex flex-col gap-3">
        <h2 id="adapters-heading" className="text-lg font-semibold">
          Active adapters
        </h2>
        <p className="text-slate-400">
          Every external boundary is a port. With no cloud credentials configured the process runs
          against local adapters, which is how the platform stays testable and demoable offline.
        </p>
        <ul className="grid gap-2 sm:grid-cols-3">
          {adapters.map((adapter) => (
            <li
              key={adapter.port}
              className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3"
            >
              <p className="text-xs tracking-wider text-slate-400 uppercase">{adapter.port}</p>
              <p className="font-mono text-sm text-sky-300">{adapter.kind}</p>
            </li>
          ))}
        </ul>
        <p className="text-sm text-slate-500">
          Data adapter health: {data.ok ? 'reachable' : 'unreachable'}
          {data.detail === undefined ? '' : ` — ${data.detail}`}
        </p>
      </section>

      <section aria-labelledby="modules-heading" className="flex flex-col gap-3">
        <h2 id="modules-heading" className="text-lg font-semibold">
          Modules
        </h2>
        <p className="text-slate-400">
          Five capabilities, and a status for each. The two that do not exist are named rather than
          omitted, so nothing here can be mistaken for a feature by being adjacent to one that
          works.
        </p>
        <ul className="flex flex-col divide-y divide-slate-800 rounded-lg border border-slate-800">
          {MODULES.map((module) => (
            <li key={module.name} className="flex flex-col gap-1 px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-medium">{module.name}</span>
                <span
                  className={
                    module.status === 'not implemented'
                      ? 'font-mono text-xs text-slate-500'
                      : 'font-mono text-xs text-emerald-300'
                  }
                >
                  {module.status}
                </span>
              </div>
              <p className="text-sm text-slate-400">
                <span className="mr-2 text-slate-500 italic">{module.meaning}</span>
                {module.responsibility}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-800 pt-6 text-sm text-slate-500">
        <span>Version {APP_VERSION}</span>
        <Link className="text-sky-400 underline-offset-4 hover:underline" href="/capture">
          Capture
        </Link>
        <Link className="text-sky-400 underline-offset-4 hover:underline" href="/visibility">
          Visibility
        </Link>
        <Link className="text-sky-400 underline-offset-4 hover:underline" href="/dataset">
          Dataset inspector
        </Link>
        <Link className="text-sky-400 underline-offset-4 hover:underline" href="/redistribution">
          Redistribution
        </Link>
        <Link className="text-sky-400 underline-offset-4 hover:underline" href="/healthz">
          Health check
        </Link>
        <span>Licensed under Apache-2.0</span>
      </footer>
    </main>
  );
}
