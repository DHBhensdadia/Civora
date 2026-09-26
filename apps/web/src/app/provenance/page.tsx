import { ProvenancePanel } from '@/components/provenance-panel';
import { getLiveStore } from '@/lib/live-store';
import { provenanceFor } from '@/lib/provenance';

/**
 * What is real, what is generated, and under which seed.
 *
 * The destination the navigation offers for the question every surface has to be
 * able to answer. It is deliberately not a disclaimer: it names the layers that
 * were retrieved from published sources, the layers generated from them, the
 * seed and fingerprint that regenerate the same world, and the document in the
 * repository that carries each source, licence, retrieval date and assumption.
 *
 * The panel itself is shared with the surfaces that show figures, so this page
 * and the compact form on the control tower cannot drift apart.
 */

export const dynamic = 'force-dynamic';

export default async function ProvenancePage() {
  const store = await getLiveStore();

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-medium tracking-widest text-sky-400 uppercase">
          Where the data comes from
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Provenance</h1>
        <p className="max-w-3xl text-slate-300">
          A demonstration of a national platform has one failure mode worse than a wrong figure: a
          right figure mistaken for a real one. This page exists so that cannot happen quietly — it
          names which layers are published values, which are generated from them, and which seed
          produces this exact world.
        </p>
      </header>

      <ProvenancePanel id="provenance" view={provenanceFor(store.info)} />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">What that means for a figure on a surface</h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-slate-300">
          <li>
            Every generated record carries <code className="font-mono">synthetic: true</code> and a
            provenance naming the simulator. A surface that displayed one as a measurement fails the
            test suite.
          </li>
          <li>
            A facility the platform has not heard from is shown as <em>never heard from</em> or{' '}
            <em>stale</em> with its figures absent — never as a facility with full shelves. The rule
            is enforced in the ledger projection and rendered by every surface.
          </li>
          <li>
            The forecasting, risk, redistribution and federated-learning methods are real
            implementations. They ran on generated data; that is a statement about the data, not
            about the code.
          </li>
          <li>
            The ship-time substrate a deployed federation would run on is cited in{' '}
            <code className="font-mono">packages/federated/src/statement.ts</code> as documented
            rather than built, and the console says so where the federation is shown.
          </li>
        </ul>
      </section>
    </main>
  );
}
