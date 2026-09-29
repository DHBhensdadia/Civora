'use client';

import { useEffect, useState } from 'react';

import { DataTable, Notice, Panel, StatCard, formatCount } from '@/components/ui';

/**
 * Samvad: the federated rounds, what they cost, and what they do not claim.
 *
 * The page is arranged so that the strongest claim a reader might make is
 * answered before they can make it. The honesty boundary comes first, not last:
 * the silos are regions of a simulated world on one machine, the managed
 * substrate (private GKE, TensorFlow Federated, the Federated Compute Platform)
 * is documented and cited rather than built, and the ε that appears below prices
 * the model updates only — the basis' pooled statistics are an exchange this
 * build reports rather than hides.
 *
 * Two runs are shown side by side because they answer two different questions.
 * The **algorithmic run** has no mechanism: whether sharing clipped updates beats
 * a silo training alone, and whether the proximal term helps. The **priced run**
 * carries the guarantee, with the accountant's σ, the noise in the ledger, and
 * the budget accumulating round by round. The curve is what the guarantee costs,
 * measured rather than asserted — and at this cohort size it is expensive, which
 * the page states in as many words instead of leaving a reader to infer it from a
 * loss column.
 *
 * The narrative panel is a refusal today, by design. With no reasoning provider
 * configured, every round refuses with the provider's own sentence; no fixture is
 * invented to fill it, because a written summary of a federated round that no
 * model wrote would be the most convincing-lie a demo could contain.
 *
 * Nothing here is polled: the rounds are a pure function of the world, the
 * configuration and the seed, so they cannot change while a reader is looking at
 * them. A rebuild is what would change them, and the seed line at the foot of the
 * page is what a reader compares against.
 */

const fixed = (value: number, digits = 4): string => value.toFixed(digits);

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

interface RoundParticipant {
  readonly siloId: string;
  readonly label: string;
  readonly sampleCount: number;
  readonly localLoss: number;
  readonly updateNorm: number;
}

interface RoundView {
  readonly round: number;
  readonly participants: readonly RoundParticipant[];
  readonly rows: number;
  readonly meanLocalLoss: number;
  readonly globalLoss: number;
  readonly lossChange: number;
  readonly divergence: number | null;
  readonly clippedSilos: number;
  readonly largestRawNorm: number;
  readonly noiseStandardDeviation: number;
  readonly epsilonSpent: number | null;
  readonly epsilonThisRound: number | null;
  readonly bytesIn: number;
  readonly masked: boolean;
}

interface RunView {
  readonly label: string;
  readonly meaning: string;
  readonly rounds: readonly RoundView[];
  readonly initialLoss: number;
  readonly finalLoss: number;
  readonly improvement: number;
  readonly noiseMultiplier: number;
  readonly noiseReason: string;
  readonly epsilonTarget: number | null;
  readonly clipNorm: number;
  readonly delta: number;
  readonly samplingRate: number;
  readonly mu: number;
  readonly maskUpdates: boolean;
  readonly spend: {
    readonly epsilon: number;
    readonly delta: number;
    readonly bestOrder: number;
    readonly ordersEvaluated: number;
    readonly rdp: number;
  } | null;
  readonly participated: readonly string[];
}

interface ConsoleView {
  readonly honesty: {
    readonly statement: string;
    readonly reference: string;
    readonly substrate: string;
    readonly simulated: string;
  };
  readonly world: {
    readonly seed: string;
    readonly roundSeed: string;
    readonly scenarioId: string;
    readonly scenarioLabel: string;
    readonly countryId: string;
    readonly countryName: string;
    readonly regionLevelName: string;
    readonly window: { readonly from: string; readonly to: string };
  };
  readonly partition: {
    readonly silos: number;
    readonly samples: number;
    readonly seriesRead: number;
    readonly seriesTooShort: number;
    readonly censoredDaysFound: number;
    readonly censoredDaysImputed: number;
    readonly imputations: readonly string[];
    readonly regionsWithoutHistory: number;
  };
  readonly basis: {
    readonly featureNames: readonly string[];
    readonly featureCount: number;
    readonly targetMean: number;
    readonly targetScale: number;
    readonly scaleExchange: { readonly payloads: number; readonly bytes: number };
    readonly paidFor: string;
  };
  readonly algorithmic: RunView;
  readonly perSilo: readonly {
    readonly siloId: string;
    readonly label: string;
    readonly sampleCount: number;
    readonly localOnlyLoss: number;
    readonly federatedLoss: number;
    readonly difference: number;
    readonly federatedBetter: boolean;
  }[];
  readonly totals: {
    readonly localOnlyLoss: number;
    readonly federatedLoss: number;
    readonly silosWhereFederationHelped: number;
    readonly silosWhereLocalWon: number;
  };
  readonly proximal: {
    readonly mu: number;
    readonly fedAvgFinalLoss: number | null;
    readonly fedProxFinalLoss: number;
    readonly winner: 'fedavg' | 'fedprox' | null;
  };
  readonly diagnostic: {
    readonly available: boolean;
    readonly note: string;
    readonly divergenceByRound: readonly (number | null)[];
    readonly meanDivergence: number | null;
  };
  readonly priced: RunView;
  readonly curve: {
    readonly quiet: { readonly initialLoss: number; readonly finalLoss: number };
    readonly points: readonly {
      readonly epsilonTarget: number;
      readonly noiseMultiplier: number | null;
      readonly reachable: boolean;
      readonly note: string | null;
      readonly finalLoss: number | null;
      readonly improvement: number | null;
      readonly beatsMean: boolean | null;
    }[];
    readonly resolutionNote: string;
    readonly curveCommand: string;
    readonly artifactCommand: string;
  };
  readonly narratives: {
    readonly task: string;
    readonly attemptedOn: string;
    readonly oncePerProcess: string;
    readonly attempts: readonly {
      readonly round: number;
      readonly status: 'written' | 'refused';
      readonly narrative: {
        readonly headline: string;
        readonly summary: string;
        readonly limitations: readonly string[];
      } | null;
      readonly refusal: string | null;
      readonly provider: string;
      readonly model: string | null;
      readonly cacheHit: boolean;
    }[];
    readonly refusals: number;
    readonly written: number;
  };
  readonly tests: readonly { readonly command: string; readonly what: string }[];
  readonly timing: {
    readonly generatedInMs: number;
    readonly buildMs: number;
    readonly runsMs: number;
  };
}

/** The ledger, with the privacy budget spelled out per round and cumulatively. */
function LedgerTable({
  id,
  caption,
  rounds,
}: {
  readonly id: string;
  readonly caption: string;
  readonly rounds: readonly RoundView[];
}) {
  return (
    <div id={id} className="flex flex-col gap-2">
      <DataTable
        caption={caption}
        columns={[
          { header: 'round', numeric: true },
          { header: 'silos', numeric: true },
          { header: 'rows', numeric: true },
          { header: 'mean local loss', numeric: true },
          { header: 'shared loss', numeric: true },
          { header: 'change', numeric: true },
          { header: 'divergence', numeric: true },
          { header: 'clipped', numeric: true },
          { header: 'largest raw norm', numeric: true },
          { header: 'noise σ', numeric: true },
          { header: 'ε this round', numeric: true },
          { header: 'ε cumulative', numeric: true },
          { header: 'bytes/round', numeric: true },
        ]}
        rows={rounds.map((round) => [
          round.round,
          round.participants.length,
          formatCount(round.rows),
          fixed(round.meanLocalLoss),
          fixed(round.globalLoss),
          `${round.lossChange <= 0 ? '' : '+'}${fixed(round.lossChange)}`,
          round.divergence === null ? 'masked' : fixed(round.divergence),
          round.clippedSilos,
          fixed(round.largestRawNorm, 2),
          fixed(round.noiseStandardDeviation, 4),
          round.epsilonThisRound === null ? 'none' : fixed(round.epsilonThisRound, 4),
          round.epsilonSpent === null ? 'none' : fixed(round.epsilonSpent, 4),
          formatCount(round.bytesIn),
        ])}
      />
      <p className="text-xs text-fg-subtle">
        Losses are mean squared error in the shared basis, where the target has unit variance: 1 is
        what a model that predicts the pooled mean scores, so{' '}
        <span className="font-mono">1 − loss</span> is the share of the demand&rsquo;s variance the
        round explained. A masked coordinator cannot see the individual updates a divergence is
        computed from, so it reports <span className="font-mono">masked</span> rather than a number
        it does not have.
      </p>
    </div>
  );
}

export default function FederationPage() {
  const [payload, setPayload] = useState<ConsoleView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/federation')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`the federation read answered ${String(response.status)}`);
        }
        return (await response.json()) as ConsoleView;
      })
      .then((body) => {
        if (!cancelled) {
          setPayload(body);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== null) {
    return (
      <div className="flex flex-col gap-12">
        <Notice id="federation-error" tone="warning" title="The federation console could not read">
          <p>{error}</p>
        </Notice>
      </div>
    );
  }

  if (payload === null) {
    return (
      <div className="flex flex-col gap-12">
        <p className="text-fg-muted">
          Running the federated rounds over the demonstration world — the partition, two runs and
          the curve. This takes a few seconds, once per server process.
        </p>
      </div>
    );
  }

  const { algorithmic, priced, curve } = payload;
  const cost =
    curve.quiet.initialLoss === 0 ? 0 : 1 - curve.quiet.finalLoss / curve.quiet.initialLoss;

  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-eyebrow text-accent uppercase">Samvad · federation</p>
        <h1 className="text-display text-balance">Federated learning across state silos</h1>
        <p className="max-w-measure text-lg text-fg-muted">
          Each {payload.world.regionLevelName} is a silo. A model is trained inside each one,
          clipped as it leaves, aggregated with the others, noised, and accounted for — and no
          record ever crosses a silo boundary. The numbers below are measurements from runs this
          page performed.
        </p>
      </header>

      <Notice
        id="honesty"
        tone="warning"
        title="This is a reference implementation, not a deployment"
      >
        <p>{payload.honesty.statement}</p>
        <p>{payload.honesty.reference}</p>
        <p>{payload.honesty.substrate}</p>
        <p>{payload.honesty.simulated}</p>
      </Notice>

      <section
        aria-label="The run at a glance"
        className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        <StatCard
          label="Silos"
          value={formatCount(payload.partition.silos)}
          hint={`${formatCount(payload.partition.seriesRead)} series read, ${formatCount(
            payload.partition.samples,
          )} training rows`}
        />
        <StatCard
          label="Rounds"
          value={String(algorithmic.rounds.length)}
          hint={`${algorithmic.participated.length} silo(s) took part at least once`}
        />
        <StatCard
          label="Shared model, no mechanism"
          value={percent(algorithmic.improvement)}
          hint={`${fixed(algorithmic.initialLoss)} → ${fixed(algorithmic.finalLoss)}: share of the demand’s variance explained`}
        />
        <StatCard
          label="Priced at this ε"
          value={percent(priced.improvement)}
          hint={`ε target ${String(priced.epsilonTarget ?? 'none')} at δ ${String(priced.delta)}`}
        />
        <StatCard
          label="Non-IID divergence"
          value={
            payload.diagnostic.meanDivergence === null
              ? 'not measured'
              : fixed(payload.diagnostic.meanDivergence, 4)
          }
          hint="0 identical updates, 1 disjoint — measured in a run with masking off"
        />
      </section>

      <Panel
        id="what-ran"
        title="What was run, and on what"
        description="The world, the partition, the basis and the two seams a reader should know about before reading a single figure."
      >
        <ul className="flex flex-col gap-2 text-sm text-fg-muted">
          <li>
            <span className="text-fg-subtle">World:</span> {payload.world.countryName} at{' '}
            {payload.world.regionLevelName} level · scenario {payload.world.scenarioId} (
            {payload.world.scenarioLabel}) · window {payload.world.window.from} →{' '}
            {payload.world.window.to} · generated from the published seed{' '}
            <span className="font-mono">{payload.world.seed}</span>
          </li>
          <li>
            <span className="text-fg-subtle">Partition:</span>{' '}
            {formatCount(payload.partition.silos)} silo(s),{' '}
            {formatCount(payload.partition.seriesTooShort)} series too short to use,{' '}
            {formatCount(payload.partition.regionsWithoutHistory)} region(s) with no history at all
            — counted rather than silently emptied.
          </li>
          <li>
            <span className="text-fg-subtle">Censored demand:</span>{' '}
            {formatCount(payload.partition.censoredDaysFound)} day(s) found and{' '}
            {formatCount(payload.partition.censoredDaysImputed)} imputed (
            {payload.partition.imputations.join(', ') || 'no correction needed'}) — a stock-out is
            not low demand, so the history is repaired before it is fitted.
          </li>
          <li>
            <span className="text-fg-subtle">The basis:</span> {payload.basis.featureCount}{' '}
            feature(s) from Phase 4&rsquo;s own schema, pooled across the silos from sums and counts
            — {formatCount(payload.basis.scaleExchange.payloads)} statistic payload(s),{' '}
            {formatCount(payload.basis.scaleExchange.bytes)} bytes — and the target standardised
            with them (mean {fixed(payload.basis.targetMean, 2)}, spread{' '}
            {fixed(payload.basis.targetScale, 2)}, in units of demand). An average of updates in
            different units is not a model of anything, so the basis is agreed before round one.
          </li>
        </ul>
        <p className="rounded-instrument border border-ink-700 bg-ink-900 p-4 text-sm text-signal-watch/80">
          {payload.basis.paidFor}
        </p>
      </Panel>

      <Panel
        id="algorithmic"
        title={`The federation itself — ${algorithmic.label}`}
        description={`${algorithmic.meaning}. Comparisons are taken from this run, because a silo training alone needs no privacy mechanism: comparing a priced model against a noise-free local one would measure the noise and call it the federation.`}
      >
        <section aria-label="The algorithmic run" className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Variance explained"
            value={percent(algorithmic.improvement)}
            hint={`loss ${fixed(algorithmic.initialLoss)} → ${fixed(algorithmic.finalLoss)}`}
          />
          <StatCard
            label="Silos the federation helped"
            value={`${String(payload.totals.silosWhereFederationHelped)} of ${String(
              payload.perSilo.length,
            )}`}
            hint={`weighted over the rows: local-only ${fixed(
              payload.totals.localOnlyLoss,
            )} against federated ${fixed(payload.totals.federatedLoss)}`}
          />
          <StatCard
            label="FedAvg against FedProx"
            value={
              payload.proximal.winner === null ? 'same run' : `${payload.proximal.winner} lower`
            }
            hint={
              payload.proximal.fedAvgFinalLoss === null
                ? 'μ = 0 was configured, so both variants are one run'
                : `FedAvg ${fixed(payload.proximal.fedAvgFinalLoss)} · FedProx (μ = ${String(
                    payload.proximal.mu,
                  )}) ${fixed(payload.proximal.fedProxFinalLoss)}`
            }
          />
        </section>
        <LedgerTable
          id="algorithmic-ledger"
          caption="Round ledger of the run with no privacy mechanism"
          rounds={algorithmic.rounds}
        />
      </Panel>

      <Panel
        id="per-silo"
        title="Local-only against federated, per silo"
        description="The local-only column is a model trained on that silo's rows alone, from the same zero model, with the same epochs, batch size and optimiser — so the difference is the federation. A silo where training alone won is listed as a loss."
      >
        <DataTable
          caption="Per-silo comparison of local-only training against the federated model"
          columns={[
            { header: 'silo' },
            { header: 'rows', numeric: true },
            { header: 'local-only loss', numeric: true },
            { header: 'federated loss', numeric: true },
            { header: 'difference', numeric: true },
            { header: 'verdict' },
          ]}
          rows={payload.perSilo.map((entry) => [
            entry.siloId,
            formatCount(entry.sampleCount),
            fixed(entry.localOnlyLoss),
            fixed(entry.federatedLoss),
            `${entry.difference >= 0 ? '+' : ''}${fixed(entry.difference)}`,
            entry.federatedBetter ? 'federation lower' : 'training alone lower',
          ])}
        />
      </Panel>

      <Panel
        id="priced"
        title={`The same rounds with a privacy guarantee — ${priced.label}`}
        description={`${priced.meaning}. ${priced.noiseReason}`}
      >
        <section aria-label="The privacy spend" className="grid gap-3 sm:grid-cols-4">
          <StatCard
            label="σ"
            value={fixed(priced.noiseMultiplier)}
            hint={`per-coordinate noise σ · clip ${String(priced.clipNorm)} · w_max`}
          />
          <StatCard
            label="ε spent"
            value={priced.spend === null ? 'no mechanism' : fixed(priced.spend.epsilon, 6)}
            hint={
              priced.spend === null
                ? 'no noise was added, so there is no bound to report'
                : `at order ${String(priced.spend.bestOrder)} of ${String(
                    priced.spend.ordersEvaluated,
                  )} evaluated · RDP ${fixed(priced.spend.rdp, 6)}`
            }
          />
          <StatCard label="δ" value={String(priced.delta)} hint="the conversion target" />
          <StatCard
            label="Variance explained"
            value={percent(priced.improvement)}
            hint={`loss ${fixed(priced.initialLoss)} → ${fixed(priced.finalLoss)}`}
          />
        </section>
        <LedgerTable
          id="priced-ledger"
          caption="Round ledger of the run with Gaussian noise and a spent privacy budget"
          rounds={priced.rounds}
        />
        <p className="rounded-instrument border border-signal-watch/40 bg-signal-watch/10 p-4 text-sm text-signal-watch/90">
          Read the two loss columns together before repeating either. At this cohort size the noise
          the accountant prices is expensive: the curve below is the measurement of what each target
          ε buys, and it is not presented as free anywhere.
        </p>
      </Panel>

      <Panel
        id="curve"
        title="ε against accuracy — what the guarantee costs"
        description={`${curve.resolutionNote} Every point is a real run of the same rounds, with the noise multiplier the accountant solved for that target.`}
      >
        <DataTable
          caption="The privacy/accuracy curve: one real run per target epsilon"
          columns={[
            { header: 'ε target', numeric: true },
            { header: 'σ solved', numeric: true },
            { header: 'reachable', numeric: true },
            { header: 'final loss', numeric: true },
            { header: 'variance explained', numeric: true },
            { header: 'verdict' },
          ]}
          rows={[
            ...curve.points.map((point) => [
              String(point.epsilonTarget),
              point.noiseMultiplier === null ? '—' : fixed(point.noiseMultiplier),
              point.reachable ? 'yes' : 'no',
              point.finalLoss === null ? '—' : fixed(point.finalLoss),
              point.improvement === null ? '—' : percent(point.improvement),
              point.reachable
                ? point.beatsMean === true
                  ? 'better than predicting the pooled mean'
                  : 'worse than predicting the pooled mean'
                : (point.note ?? 'unreachable'),
            ]),
            [
              'none',
              '0',
              'yes',
              fixed(curve.quiet.finalLoss),
              percent(cost),
              'the ceiling these targets are read against',
            ],
          ]}
        />{' '}
        <p className="text-sm text-fg-muted">
          With no mechanism at all the run explained {percent(cost)} of the demand&rsquo;s variance;
          the gap between that row and a priced row is what the privacy costs at that target, and it
          is stated rather than smoothed away. The noise is priced at σ · clip · w_max, and w_max is
          the largest silo&rsquo;s share of the rows — so a cohort with more silos buys less noise
          for the same ε.
        </p>
        <p className="text-xs text-fg-subtle">
          These three points, exactly as drawn here:{' '}
          <span className="font-mono">{curve.curveCommand}</span>. The full-resolution curve — every
          target from 1 to 128, six rounds a point, with both comparison tables and the honest
          reading of the negative region — is the generated document{' '}
          <span className="font-mono">docs/federated-tradeoff.md</span>, written by{' '}
          <span className="font-mono">{curve.artifactCommand}</span>.
        </p>
      </Panel>

      <Panel id="diagnostic" title="The non-IID diagnostic" description={payload.diagnostic.note}>
        <p className="text-sm text-fg-muted">
          {payload.diagnostic.available && payload.diagnostic.meanDivergence !== null ? (
            <>
              Mean divergence{' '}
              <span className="font-mono text-accent">
                {fixed(payload.diagnostic.meanDivergence, 4)}
              </span>{' '}
              over {payload.diagnostic.divergenceByRound.length} round(s): 0 would mean every silo
              proposed the same direction, and values approaching 1 mean their proposals barely
              overlap — the situation the proximal term exists for.
            </>
          ) : (
            <span>{payload.diagnostic.note}</span>
          )}
        </p>
        <DataTable
          caption="Divergence of the silos' updates per round, measured with masking off"
          columns={[
            { header: 'round', numeric: true },
            { header: 'divergence', numeric: true },
          ]}
          rows={payload.diagnostic.divergenceByRound.map((value, index) => [
            String(index),
            value === null ? 'not computable' : fixed(value),
          ])}
        />
      </Panel>

      <Panel
        id="narrative"
        title={`The round narrative — ${payload.narratives.task}`}
        description={`Written through the reasoning port with a schema-locked, grounded prompt: every numeral in a narrative has to appear in the round's own facts, and a citation has to name a fact the round carries. ${payload.narratives.oncePerProcess}`}
      >
        <p className="text-sm text-fg-muted">
          {payload.narratives.written === 0
            ? `${String(payload.narratives.refusals)} of ${String(payload.narratives.attempts.length)} round(s) refused a narrative, and no fixture was invented to fill the panel: a summary no model wrote would be the most convincing thing on this page and the least true.`
            : `${String(payload.narratives.written)} of ${String(payload.narratives.attempts.length)} round(s) were written; ${String(payload.narratives.refusals)} refused.`}
        </p>
        <DataTable
          caption="Per-round narrative attempts and their outcomes"
          columns={[
            { header: 'round', numeric: true },
            { header: 'status' },
            { header: 'provider' },
            { header: 'body or the provider’s sentence' },
          ]}
          rows={payload.narratives.attempts.map((attempt) => [
            String(attempt.round),
            attempt.status,
            attempt.provider,
            attempt.status === 'written' && attempt.narrative !== null
              ? `${attempt.narrative.headline} — ${attempt.narrative.summary}`
              : (attempt.refusal ?? 'no reason reported'),
          ])}
        />
      </Panel>

      <Panel
        id="reproduce"
        title="How to reproduce every figure here"
        description="The surface and the commands run the same code over the same world, which is why they cannot disagree about what was run — and the privacy claim they share is falsifiable by test, not by assertion."
      >
        <DataTable
          caption="The commands behind the privacy claim and this page"
          columns={[{ header: 'command' }, { header: 'what it holds' }]}
          rows={payload.tests.map((entry) => [
            <span key={entry.command} className="font-mono text-xs">
              {entry.command}
            </span>,
            entry.what,
          ])}
        />
        <p className="text-xs text-fg-subtle">
          Round seed <span className="font-mono">{payload.world.roundSeed}</span> · built in{' '}
          {formatCount(payload.timing.buildMs)} ms ({formatCount(payload.timing.runsMs)} ms of it in
          the runs, {formatCount(payload.timing.generatedInMs)} ms generating the world) · computed
          once per server process.
        </p>
      </Panel>
    </div>
  );
}
