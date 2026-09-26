import { Panel } from './ui';
import type { ProvenanceView } from '@/lib/provenance';

/**
 * What is real and what is generated, on the page that shows the figures.
 *
 * The rule this component exists to keep is that **a simulated value never
 * appears without this panel being reachable from the same page**. Not "the
 * README says it" and not "the footer says it": the panel names both layer sets,
 * shows the active seed and fingerprint so a reader can regenerate the same
 * world, and points at the document that carries the sources, licences and
 * assumptions.
 *
 * It is rendered in two places by design. The full page (`/provenance`) is the
 * destination the navigation offers; the compact form is embedded on the
 * surfaces that show numbers, where a reader meets it without having to go
 * looking.
 */

export interface ProvenancePanelProps {
  readonly id: string;
  readonly view: ProvenanceView;
  /** `full` lists every layer; `compact` names the split and the seed. */
  readonly size?: 'full' | 'compact';
}

export function ProvenancePanel({ id, view, size = 'full' }: ProvenancePanelProps) {
  const layers = [
    {
      key: 'real',
      title: 'Retrieved from published sources',
      tone: 'text-emerald-300',
      entries: view.realLayers,
    },
    {
      key: 'simulated',
      title: 'Generated from those sources',
      tone: 'text-amber-300',
      entries: view.simulatedLayers,
    },
  ];

  return (
    <Panel
      id={id}
      title="Data provenance"
      description={
        <>
          Nothing on this platform is real health data. The layer lists below say what that means
          precisely: the anchors are published values, everything the platform reasons about is
          generated from them, and every generated record carries <code>synthetic: true</code> so a
          surface that displayed one as a measurement would fail the test suite.
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {layers.map((group) => (
          <div
            key={group.key}
            data-testid={id === 'provenance' ? `provenance-${group.key}` : undefined}
            className="rounded-lg border border-slate-800 bg-slate-900/60 p-4"
          >
            <h3 className={`text-sm font-medium ${group.tone}`}>{group.title}</h3>
            <ul className="mt-3 flex flex-col gap-3">
              {group.entries.map((layer) => (
                <li key={layer.layer} className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-200">{layer.layer}</span>
                  {size === 'full' ? (
                    <>
                      <span className="text-slate-400">{layer.detail}</span>
                      <span className="text-xs text-slate-500">{layer.source}</span>
                    </>
                  ) : (
                    <span className="text-xs text-slate-500">{layer.source}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <dl
        data-testid={`${id}-seed`}
        className="grid gap-x-6 gap-y-2 rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm sm:grid-cols-2"
      >
        <div>
          <dt className="text-slate-400">Active seed</dt>
          <dd className="font-mono text-sky-300">{view.seed}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Dataset fingerprint</dt>
          <dd className="font-mono text-slate-300">{view.fingerprint}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Scenario</dt>
          <dd className="text-slate-300">
            {view.scenarioLabel} <span className="font-mono text-xs">({view.scenarioId})</span>
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Window</dt>
          <dd className="text-slate-300">
            {view.window.from} → {view.window.to} · {view.window.days} days
          </dd>
        </div>
      </dl>

      <p className="text-sm text-slate-400">
        The sources, licences, retrieval dates and every assumption are in{' '}
        <span className="font-mono text-slate-300">{view.document}</span> in the repository, and the
        same values are browsable in the dataset inspector at <code>/dataset</code>.
      </p>
    </Panel>
  );
}
