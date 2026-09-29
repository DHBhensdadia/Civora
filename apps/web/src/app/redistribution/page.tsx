'use client';

import { useCallback, useEffect, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { Notice, Panel, StatCard } from '@/components/ui';

/**
 * Setu: the transfer proposals, the verdict on each, and the decision a person
 * takes on it.
 *
 * The page is the phase's discipline made visible, and it is arranged in the
 * order that discipline runs. The plan is the optimiser's; the verdict on every
 * proposal is the **independent validator's**, shown on the row rather than
 * behind a click; the impact is the estimator's, with the assumptions it printed
 * beside the figure; the rationale is written by the reasoning layer through a
 * grounded schema; and the decision is a person's, recorded with a reason and an
 * actor in a hash-chained trail.
 *
 * Nothing on this page moves stock. That is not a caveat in a footnote — it is
 * stated at the top, because a surface that shows a transfer and an approve
 * button invites exactly the assumption this platform must refuse: that
 * approving executes something. Execution is deliberately outside this build;
 * the approval is the end of the pipeline.
 *
 * The data is polled over HTTP like the other surfaces, because the local
 * adapter has no change feed. The plan is computed once per server process and
 * memoised, which is what makes a five-second poll cheap: what changes between
 * two polls is a *decision*, not a plan. `pnpm worker:propose` recomputes the
 * same plan as a batch step and prints a digest of it, so the figures here can
 * be reproduced outside a browser — in a process of its own, whose store is its
 * own until there is a durable one (Phase 9/10). That is why a refreshed plan
 * reaches this page when the server rebuilds rather than mid-poll, and the page
 * says so rather than implying the poll is watching the optimiser.
 */

/** How often to re-read. Short enough to see a decision land, long enough to be cheap. */
const REFRESH_INTERVAL_MS = 5000;

interface SessionView {
  readonly role: string;
  readonly label: string;
}

interface FacilityView {
  readonly facilityId: string;
  readonly name: string;
  readonly tier: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly regionName: string;
}

interface ItemView {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly essentiality: string;
  readonly coldChain: boolean;
}

interface ProposalView {
  readonly id: string;
  readonly quantity: number;
  readonly batchId: string | null;
  readonly verdict: string;
  readonly violations: readonly { readonly constraint: string; readonly detail: string }[];
  readonly expectedImpact: {
    readonly unmetDemandAvoided: number;
    readonly donorDaysOfStockAfter: number;
    readonly receiverDaysOfStockAfter: number;
    readonly assumptions: readonly string[];
  };
  readonly approvals: readonly {
    readonly by: string;
    readonly role: string;
    readonly at: string;
    readonly reason: string | null;
  }[];
  readonly synthetic: boolean;
}

interface TransferView {
  readonly distanceKm: number;
  readonly leadTimeDays: number;
  readonly shelfLifeOnArrivalDays: number;
  readonly expiresOn: string;
  readonly coldChain: boolean;
}

interface ImpactView {
  readonly units: number;
  readonly expectedUnmetDemandAvoided: number;
  readonly expectedStockOutDaysAverted: number;
  readonly baselineUnmetDemand: number;
  readonly withTransferUnmetDemand: number;
  readonly transportCost: number;
  readonly netBenefit: number;
  readonly assessment: 'beneficial' | 'marginal' | 'negative';
  readonly note: string;
}

interface DecisionView {
  readonly decision: 'approved' | 'rejected';
  readonly by: string;
  readonly actorRole: string;
  readonly at: string;
  readonly reason: string | null;
  readonly action: string;
}

interface RowView {
  readonly proposal: ProposalView;
  readonly transfer: TransferView;
  readonly impact: ImpactView | null;
  readonly donor: FacilityView;
  readonly receiver: FacilityView;
  readonly item: ItemView;
  readonly decision: DecisionView | null;
}

interface ObjectiveView {
  readonly unmetDemandPenalty: number;
  readonly transportCost: number;
  readonly expiryPenalty: number;
  readonly total: number;
}

interface StrategyView {
  readonly name: string;
  readonly description: string;
  readonly acceptable: boolean;
  readonly refusal: string | null;
  readonly benefitPerUnitKm: number;
  readonly transfers: number;
  readonly units: number;
  readonly unitKm: number;
  readonly objective: ObjectiveView;
  readonly violations: readonly { readonly rule: string; readonly detail: string }[];
  readonly unchecked: readonly { readonly rule: string; readonly detail: string }[];
  readonly chosen: boolean;
}

interface PlanVerdictView {
  readonly valid: boolean;
  readonly violations: readonly {
    readonly rule: string;
    readonly code: string;
    readonly detail: string;
  }[];
  readonly unchecked: readonly { readonly rule: string; readonly detail: string }[];
  readonly measured: {
    readonly transfers: number;
    readonly units: number;
    readonly unitKm: number;
  };
}

interface AuditEventView {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorUid: string;
  readonly actorRole: string;
  readonly action: string;
  readonly subjectId: string;
  readonly reason: string | null;
  readonly hash: string;
  readonly previousHash: string | null;
}

interface AssumptionsView {
  readonly method: string;
  readonly scenarios: readonly string[];
  readonly horizonDays: number;
  readonly costPerUnitKm: number;
  readonly weightedByShortfallProbability: boolean;
}

interface RedistributionPayload {
  readonly session: SessionView;
  readonly auditEvents: readonly AuditEventView[];
  readonly asOf: string;
  readonly seed: string;
  readonly scenarioId: string;
  readonly scenarioLabel: string;
  readonly generatedInMs: number;
  readonly rows: readonly RowView[];
  readonly strategies: readonly StrategyView[];
  readonly chosen: {
    readonly name: string;
    readonly decidedBy: 'model' | 'fallback';
    readonly reason: string;
    readonly iterations: number;
    readonly budgetReached: boolean;
    readonly refusals: readonly {
      readonly strategy: string;
      readonly reason: string;
      readonly violations: readonly string[];
    }[];
  };
  readonly verdict: PlanVerdictView;
  readonly refused: readonly { readonly rule: string; readonly detail: string }[];
  readonly totals: {
    readonly proposals: number;
    readonly units: number;
    readonly unitKm: number;
    readonly unmetDemandAvoided: number;
    readonly stockOutDaysAverted: number;
    readonly transportCost: number;
    readonly netBenefit: number;
    readonly beneficial: number;
    readonly marginal: number;
    readonly negative: number;
    readonly unquantified: number;
  };
  readonly unquantified: readonly {
    readonly receiverId: string;
    readonly itemId: string;
    readonly reason: string;
  }[];
  readonly objective: ObjectiveView;
  readonly baseline: ObjectiveView;
  readonly improvementPasses: number;
  readonly graph: {
    readonly edges: number;
    readonly candidates: number;
    readonly removedByRule: Readonly<Record<string, number>>;
    readonly unknownFacilities: number;
    readonly unknownItems: number;
  };
  readonly rankings: {
    readonly receiversRanked: number;
    readonly receiversUnmeasured: number;
    readonly donorsEligible: number;
    readonly donorsIneligible: number;
    readonly needs: number;
    readonly unpositionedReceivers: number;
  };
  readonly ineligibleDonors: readonly {
    readonly facilityName: string;
    readonly itemName: string;
    readonly reason: string;
  }[];
  readonly unmeasuredReceivers: readonly {
    readonly facilityName: string;
    readonly itemName: string;
    readonly reason: string;
  }[];
  readonly unserved: readonly {
    readonly facilityName: string;
    readonly itemName: string;
    readonly units: number;
    readonly reason: string;
  }[];
  readonly transport: {
    readonly budgetUnitKm: number;
    readonly edgeCapacityUnits: number;
    readonly reactionBufferDays: number;
  };
  readonly impactAssumptions: AssumptionsView;
  readonly impactMethod: string;
  readonly audit: {
    readonly events: number;
    readonly valid: boolean;
    readonly brokenAt: string | null;
    readonly detail: string;
  };
  readonly national: boolean;
  readonly hidden: number;
  readonly scopeNote: string;
}

interface RationaleView {
  readonly proposalId: string;
  readonly status: 'written' | 'refused';
  readonly summary: string | null;
  readonly conditions: readonly string[];
  readonly citations: readonly string[];
  readonly refusal: string | null;
  readonly model: string | null;
  readonly cacheHit: boolean;
  readonly attemptedAt: string;
}

interface RationaleSetView {
  readonly provider: string;
  readonly proposals: number;
  readonly rationales: readonly RationaleView[];
  readonly attempted: number;
  readonly written: number;
  readonly refused: number;
  readonly regenerated: boolean;
  readonly generatedAt: string;
  readonly generatedInMs: number;
}

const ASSESSMENT_CLASSES: Readonly<Record<string, string>> = {
  beneficial: 'border-signal-ok/40 bg-signal-ok/10 text-signal-ok',
  marginal: 'border-signal-watch/40 bg-signal-watch/10 text-signal-watch',
  negative: 'border-signal-critical/40 bg-signal-critical/10 text-signal-critical',
};

const number = (value: number): string => value.toLocaleString('en-IN');

const decimal = (value: number, digits = 2): string => value.toFixed(digits);

export default function RedistributionPage() {
  const [payload, setPayload] = useState<RedistributionPayload | null>(null);
  const [rationales, setRationales] = useState<RationaleSetView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [rationaleResult, setRationaleResult] = useState<string | null>(null);
  const [rationaleBusy, setRationaleBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/redistribution');
      if (!response.ok) {
        setError(`the platform answered ${String(response.status)}`);
        return;
      }
      setPayload((await response.json()) as RedistributionPayload);
      setError(null);
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the read failed');
    }
  }, []);

  /**
   * Ask the writer for the set once, and answer from the process afterwards.
   *
   * Deliberately outside the poll below: a read of this set is what makes the
   * platform write explanations, and a five-second poll would turn the batch step
   * into a repeated one. With no provider configured every proposal refuses —
   * that is the shipping state, and the button is how a reader asks again.
   */
  const loadRationales = useCallback(async (regenerate = false): Promise<void> => {
    setRationaleBusy(true);
    try {
      const response = await fetch('/api/rationales', {
        method: regenerate ? 'POST' : 'GET',
        ...(regenerate
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ regenerate: true }),
            }
          : {}),
      });
      if (!response.ok) {
        setRationaleResult(`the rationale read answered ${String(response.status)}`);
        return;
      }
      const set = (await response.json()) as RationaleSetView;
      setRationales(set);
      setRationaleResult(
        regenerate
          ? `Asked the writer again for ${String(set.proposals)} proposal(s): ${String(set.written)} written, ${String(set.refused)} refused.`
          : null,
      );
    } finally {
      setRationaleBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadRationales();
    const timer = setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load, loadRationales]);

  const decide = async (row: RowView, decision: 'approved' | 'rejected'): Promise<void> => {
    const reason = (reasons[row.proposal.id] ?? '').trim();
    setBusy(`${row.proposal.id}:${decision}`);
    setRefusal(null);

    try {
      const response = await fetch('/api/redistribution/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposalId: row.proposal.id, decision, reason }),
      });
      const body = (await response.json()) as { detail?: string };

      if (!response.ok) {
        setRefusal(body.detail ?? `the decision was refused with ${String(response.status)}`);
        return;
      }

      setReasons((current) => ({ ...current, [row.proposal.id]: '' }));
      await load();
    } catch (cause) {
      setRefusal(cause instanceof Error ? cause.message : 'the decision failed');
    } finally {
      setBusy(null);
    }
  };

  if (payload === null) {
    return (
      <PageHeader spacing="roomy" title="Setu — redistribution workbench">
        <p className="text-sm text-ink-muted">
          {error === null
            ? 'Planning transfers from the demonstration dataset — graph, rankings, four weightings, validator, impact…'
            : `The redistribution read failed: ${error}`}
        </p>
      </PageHeader>
    );
  }

  const rationaleOf = (proposalId: string): RationaleView | null =>
    rationales?.rationales.find((view) => view.proposalId === proposalId) ?? null;

  const unchecked =
    payload.verdict.unchecked.length === 0
      ? 'none — every rule could be evaluated'
      : payload.verdict.unchecked.map((entry) => `${entry.rule} (${entry.detail})`).join('; ');

  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        label="Constraint-checked transfers"
        spacing="roomy"
        title="Setu — redistribution workbench"
      >
        <p className="max-w-measure text-sm text-ink-muted">
          Transfers the optimiser proposes, each one judged by a validator that re-derives it from
          the world rather than trusting the solver, priced by an estimator that prints its
          assumptions, and decided by a person with a reason. What decides the plan is the
          optimiser; the model may choose a weighting and explain — it never sets a quantity.
        </p>
        <p className="text-xs text-ink-subtle">
          Every proposal is derived from the generated dataset (`{payload.seed}`, scenario{' '}
          {payload.scenarioId}, plan built in {number(payload.generatedInMs)} ms). Refreshes every 5
          seconds (polling, because the local adapter has no change feed). The plan is computed once
          per server process, so a poll is a read and never a rebuild;{' '}
          <code className="font-mono">pnpm worker:propose</code> recomputes it from the same inputs
          and prints a digest of it. Last read {updatedAt}.
        </p>
      </PageHeader>

      <div data-testid="ui-honesty">
        <Notice id="honesty" tone="info" title="A transfer is a proposal, not a command">
          Nothing on this page moves stock. An approval is the end of the pipeline: it records who
          decided, when and why, and the transfer is not executed by this platform. Execution is
          deliberately outside this build, because a ministry will not accept logistics that execute
          themselves. Approving or rejecting a proposal is the only write here, and it requires a
          reason.
        </Notice>
      </div>

      {payload.national ? null : (
        <Notice id="scope" tone="info" title="Scoped read">
          {payload.scopeNote}
        </Notice>
      )}

      {payload.session.role === 'auditor' ? (
        <Notice id="auditor" tone="info" title="Read-only identity">
          This session is an auditor: it reads the record and does not write to it. Every decision
          below will be refused, which is the rule working rather than the interface failing.
        </Notice>
      ) : null}

      {refusal === null ? null : (
        <div data-testid="decision-refusal">
          <Notice id="refusal" tone="warning" title="That decision was refused">
            {refusal}
          </Notice>
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Proposals"
          value={number(payload.totals.proposals)}
          hint={`${number(payload.totals.beneficial)} beneficial · ${number(
            payload.totals.marginal,
          )} marginal · ${number(payload.totals.negative)} negative`}
        />
        <StatCard
          label="Units proposed"
          value={number(payload.totals.units)}
          hint={`${number(payload.totals.unitKm)} unit-km at ${decimal(
            payload.impactAssumptions.costPerUnitKm,
            3,
          )} per unit-km`}
        />
        <StatCard
          label="Expected unmet demand avoided"
          value={decimal(payload.totals.unmetDemandAvoided, 1)}
          hint={`${decimal(payload.totals.stockOutDaysAverted, 1)} stock-out days averted · net ${decimal(
            payload.totals.netBenefit,
          )}`}
        />
        <StatCard
          label="Decisions recorded"
          value={number(payload.audit.events)}
          hint={
            payload.audit.valid
              ? `chain verified at ${payload.asOf}`
              : `chain broken at ${payload.audit.brokenAt ?? 'an unknown entry'}`
          }
        />
      </section>

      <Panel
        eyebrow="Strategy"
        id="chosen"
        title="How the plan was chosen"
        description="Four stated weightings, judged rather than trusted: each is run through the solver and then through the validator, and one is selected. With no reasoning provider configured the selection is the deterministic fallback — the shipped path — which ranks only validator-admitted strategies by unmet demand avoided per unit-kilometre and names the figure it ranked on."
      >
        <div
          className="flex flex-col gap-1 rounded-card border border-hairline bg-paper-raised px-3 py-2 text-sm text-ink-muted"
          data-testid="chosen-strategy"
        >
          <p>
            Chosen: <span className="font-mono text-accent">{payload.chosen.name}</span> · decided
            by <span className="font-mono">{payload.chosen.decidedBy}</span>
            {payload.chosen.decidedBy === 'fallback'
              ? ' (deterministic fallback: no model selected)'
              : null}
          </p>
          <p className="text-xs text-ink-muted">{payload.chosen.reason}</p>
          <p className="text-xs text-ink-subtle">
            {number(payload.chosen.iterations)} attempt(s) ·
            {payload.chosen.budgetReached
              ? ' the iteration budget was reached, so the fallback stands'
              : ' the selection finished inside its iteration budget'}
          </p>
        </div>

        {payload.chosen.refusals.length === 0 ? null : (
          <ul
            className="mt-3 flex flex-col gap-1 text-xs text-signal-watch"
            data-testid="strategy-refusals"
          >
            {payload.chosen.refusals.map((strategyRefusal, index) => (
              <li key={`${strategyRefusal.strategy}:${String(index)}`}>
                <span className="font-mono">{strategyRefusal.strategy}</span> was judged and
                refused: {strategyRefusal.reason}
                {strategyRefusal.violations.length === 0
                  ? ''
                  : ` (${strategyRefusal.violations.join(', ')})`}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 overflow-x-auto rounded-card border border-hairline">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              The four stated weightings, with the strategy that was selected
            </caption>
            <thead>
              <tr className="border-b border-hairline bg-paper-raised text-left">
                <th scope="col" className="px-4 py-2 font-medium text-ink-muted">
                  Weighting
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium text-ink-muted">
                  Transfers
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium text-ink-muted">
                  Units
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium text-ink-muted">
                  Unit-km
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium text-ink-muted">
                  Avoided / unit-km
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium text-ink-muted">
                  Objective
                </th>
                <th scope="col" className="px-4 py-2 font-medium text-ink-muted">
                  Verdict
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline/70">
              {payload.strategies.map((strategy) => (
                <tr
                  key={strategy.name}
                  data-strategy={strategy.name}
                  data-chosen={strategy.chosen ? 'yes' : 'no'}
                  data-testid="strategy"
                  className={strategy.chosen ? 'bg-accent/5' : undefined}
                >
                  <th scope="row" className="px-4 py-2 text-left font-medium text-ink">
                    {strategy.name}
                    {strategy.chosen ? (
                      <span
                        className="ml-2 rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs text-accent"
                        data-testid="strategy-chosen"
                      >
                        chosen
                      </span>
                    ) : null}
                    <span className="block text-xs font-normal text-ink-subtle">
                      {strategy.description}
                    </span>
                  </th>
                  <td className="px-4 py-2 text-right font-mono text-ink-muted">
                    {number(strategy.transfers)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-ink-muted">
                    {number(strategy.units)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-ink-muted">
                    {number(strategy.unitKm)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-ink-muted">
                    {decimal(strategy.benefitPerUnitKm, 3)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-ink-muted">
                    {decimal(strategy.objective.total)}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {strategy.acceptable ? (
                      <span className="text-signal-ok">admitted by the validator</span>
                    ) : (
                      <span className="text-signal-watch">
                        refused:{' '}
                        {strategy.refusal ?? strategy.violations.map((v) => v.rule).join(', ')}
                      </span>
                    )}
                    {strategy.unchecked.length === 0 ? null : (
                      <span className="mt-1 block text-ink-subtle">
                        unchecked: {strategy.unchecked.map((entry) => entry.rule).join(', ')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        eyebrow="Validation"
        id="verdict"
        title="The validator's verdict"
        description="A separate module re-derives the plan from the world rather than believing the solver: every constraint gets its own rule and its own failure message, and a constraint the validator cannot evaluate is reported as unchecked rather than folded into 'passed'. A plan it refuses produces no proposals at all — only the refusal, attributed rule by rule."
      >
        <div
          // The verdict leads with its status in the same rail language the alert
          // cards use, so "admitted" and "refused" are told apart before the
          // sentence under them is read.
          className={`rounded-card border border-l-2 bg-paper-raised px-4 py-3 text-sm text-ink-muted ${
            payload.verdict.valid
              ? 'border-hairline border-l-signal-ok'
              : 'border-hairline border-l-signal-critical'
          }`}
          data-testid="plan-verdict"
          data-valid={payload.verdict.valid ? 'yes' : 'no'}
        >
          <p>
            {payload.verdict.valid ? (
              <span className="text-signal-ok">
                The plan this page shows was admitted by the validator.
              </span>
            ) : (
              <span className="text-signal-critical">The validator refused the plan.</span>
            )}{' '}
            It moved {number(payload.verdict.measured.transfers)} transfer(s),{' '}
            {number(payload.verdict.measured.units)} unit(s),{' '}
            {number(payload.verdict.measured.unitKm)} unit-km.
          </p>
          <p className="mt-1 text-xs text-ink-muted">Unchecked: {unchecked}</p>
          {payload.refused.length === 0 ? null : (
            <ul className="mt-2 flex flex-col gap-1 text-xs text-signal-critical">
              {payload.refused.map((violation, index) => (
                <li key={`${violation.rule}:${String(index)}`}>
                  <span className="font-mono">{violation.rule}</span> — {violation.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <Panel
        eyebrow="Setu"
        id="proposals"
        title="Proposals"
        description="Every transfer the optimiser proposed and the validator admitted, each with the constraint verdict on the row, the impact with the assumptions it was computed under, and the explanation — written by the reasoning layer through a grounded schema, or refused with the writer's own sentence. A person approves or rejects it with a reason; nothing here executes anything."
      >
        {payload.rows.length === 0 ? (
          <p className="text-sm text-ink-muted" data-testid="proposals-empty">
            The validator admitted no transfers in this plan. On the Phase 2 &lsquo;do
            nothing&rsquo; scenario that is the expected result: the optimiser proposes nothing
            because nothing is warranted, and a system that always finds something to move is not
            trustworthy.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {payload.rows.map((row) => {
              const rationale = rationaleOf(row.proposal.id);
              const reason = reasons[row.proposal.id] ?? '';

              return (
                <li
                  key={row.proposal.id}
                  aria-label={`Transfer of ${row.item.name} from ${row.donor.name} to ${row.receiver.name}`}
                  data-proposal={row.proposal.id}
                  data-testid="proposal"
                  className="rounded-card border border-hairline bg-paper-raised p-4"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium text-ink">
                      {row.donor.name} → {row.receiver.name}
                    </span>
                    <span className="text-xs text-ink-subtle">
                      {row.donor.districtName} → {row.receiver.districtName} ·{' '}
                      {decimal(row.transfer.distanceKm, 1)} km · lead{' '}
                      {number(row.transfer.leadTimeDays)}d
                      {row.transfer.coldChain ? ' · cold chain' : ''}
                    </span>
                  </div>

                  <p className="mt-1 text-sm text-ink-muted">
                    {number(row.proposal.quantity)} {row.item.unit} of {row.item.name}
                    {row.proposal.batchId === null ? '' : ` · batch ${row.proposal.batchId}`} ·
                    expires {row.transfer.expiresOn} ({number(row.transfer.shelfLifeOnArrivalDays)}{' '}
                    days left on arrival)
                  </p>

                  <p
                    className={
                      row.proposal.verdict === 'proposed'
                        ? 'mt-2 text-xs text-signal-ok'
                        : 'mt-2 text-xs text-signal-critical'
                    }
                    data-testid="proposal-verdict"
                  >
                    Constraint verdict:{' '}
                    {row.proposal.verdict === 'proposed'
                      ? 'admitted by the validator — 12 rules checked, none failed'
                      : `refused — ${row.proposal.violations.map((violation) => violation.constraint).join(', ')}`}
                  </p>
                  <p className="text-xs text-ink-subtle">
                    Unchecked: {payload.verdict.unchecked.length === 0 ? 'none' : unchecked}
                  </p>

                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <div className="text-xs text-ink-muted">
                        <span className="font-medium text-ink-muted">Impact</span>
                        {row.impact === null ? (
                          <span className="ml-2" data-testid="impact-unquantified">
                            unquantified — no forecast covered this pair, so no figure is claimed
                          </span>
                        ) : (
                          <>
                            <span
                              className={`ml-2 rounded border px-2 py-0.5 ${ASSESSMENT_CLASSES[row.impact.assessment] ?? ''}`}
                              data-testid="impact-assessment"
                            >
                              {row.impact.assessment}
                            </span>
                            <span className="mt-1 block text-ink-muted">
                              avoids{' '}
                              <span className="font-mono">
                                {decimal(row.impact.expectedUnmetDemandAvoided, 1)}
                              </span>{' '}
                              unit(s) of unmet demand over{' '}
                              <span className="font-mono">
                                {decimal(row.impact.expectedStockOutDaysAverted, 1)}
                              </span>{' '}
                              stock-out day(s) · transport{' '}
                              <span className="font-mono">{decimal(row.impact.transportCost)}</span>{' '}
                              against net{' '}
                              <span className="font-mono">{decimal(row.impact.netBenefit)}</span>
                            </span>
                            <span className="mt-1 block text-ink-subtle">{row.impact.note}</span>
                            <span className="mt-1 block text-ink-subtle">
                              baseline unmet demand{' '}
                              <span className="font-mono">
                                {decimal(row.impact.baselineUnmetDemand, 1)}
                              </span>{' '}
                              → with this transfer{' '}
                              <span className="font-mono">
                                {decimal(row.impact.withTransferUnmetDemand, 1)}
                              </span>
                            </span>
                          </>
                        )}
                      </div>

                      <div className="text-xs text-ink-subtle">
                        <span className="text-ink-muted">
                          Assumptions printed beside the figure:
                        </span>
                        <ul className="mt-1 list-inside list-disc" data-testid="impact-assumptions">
                          {row.proposal.expectedImpact.assumptions.map((assumption) => (
                            <li key={assumption}>{assumption}</li>
                          ))}
                        </ul>
                        <span className="mt-1 block">
                          donor keeps{' '}
                          <span className="font-mono">
                            {decimal(row.proposal.expectedImpact.donorDaysOfStockAfter, 1)}
                          </span>{' '}
                          day(s) after · receiver reaches{' '}
                          <span className="font-mono">
                            {decimal(row.proposal.expectedImpact.receiverDaysOfStockAfter, 1)}
                          </span>{' '}
                          day(s)
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2" data-testid="proposal-rationale">
                      <span className="text-xs font-medium text-ink-muted">
                        Why this transfer — and what would make it wrong
                      </span>
                      {rationale === null ? (
                        <span className="text-xs text-ink-subtle">
                          The writer has not been asked about this proposal yet.
                        </span>
                      ) : rationale.status === 'written' ? (
                        <>
                          <p className="text-sm text-ink">{rationale.summary}</p>
                          {rationale.conditions.length === 0 ? null : (
                            <ul className="list-inside list-disc text-xs text-ink-muted">
                              {rationale.conditions.map((condition) => (
                                <li key={condition}>{condition}</li>
                              ))}
                            </ul>
                          )}
                          <p className="text-xs text-ink-subtle">
                            cites {rationale.citations.join(', ')}
                            {rationale.model === null ? '' : ` · ${rationale.model}`}
                          </p>
                        </>
                      ) : (
                        <p className="text-xs text-signal-watch" data-testid="rationale-refusal">
                          No rationale was written: {rationale.refusal}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 border-t border-hairline pt-3">
                    {row.decision === null ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="flex items-center gap-2 text-xs text-ink-muted">
                          Reason
                          <input
                            aria-label={`Reason for proposal ${row.proposal.id}`}
                            className="w-72 min-h-11 rounded-card border border-hairline bg-paper px-2 py-1 text-sm text-ink"
                            onChange={(event) => {
                              setReasons((current) => ({
                                ...current,
                                [row.proposal.id]: event.target.value,
                              }));
                            }}
                            value={reason}
                          />
                        </label>
                        <button
                          aria-label={`Approve proposal ${row.proposal.id}`}
                          className="inline-flex min-h-11 items-center rounded-full border-2 border-signal-ok/40 bg-signal-ok/10 px-4 text-sm text-signal-ok transition-colors duration-150 hover:bg-signal-ok/20 disabled:pointer-events-none disabled:opacity-40"
                          disabled={busy !== null}
                          onClick={() => {
                            void decide(row, 'approved');
                          }}
                          type="button"
                        >
                          Approve
                        </button>
                        <button
                          aria-label={`Reject proposal ${row.proposal.id}`}
                          className="inline-flex min-h-11 items-center rounded-full border-2 border-signal-critical/40 bg-signal-critical/10 px-4 text-sm text-signal-critical transition-colors duration-150 hover:bg-signal-critical/20 disabled:pointer-events-none disabled:opacity-40"
                          disabled={busy !== null}
                          onClick={() => {
                            void decide(row, 'rejected');
                          }}
                          type="button"
                        >
                          Reject
                        </button>
                        <span className="text-xs text-ink-subtle">
                          a decision has to say why it was made
                        </span>
                      </div>
                    ) : (
                      <p className="text-xs text-ink-muted" data-testid="proposal-decision">
                        <span
                          className={
                            row.decision.decision === 'approved'
                              ? 'rounded-card border border-signal-ok/40 bg-signal-ok/10 px-2 py-0.5 text-signal-ok'
                              : 'rounded-card border border-signal-critical/40 bg-signal-critical/10 px-2 py-0.5 text-signal-critical'
                          }
                        >
                          {row.decision.decision}
                        </span>{' '}
                        by {row.decision.by} ({row.decision.actorRole}) at {row.decision.at} —{' '}
                        {row.decision.reason ?? 'no reason recorded'}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        eyebrow="Rationale"
        id="rationale-set"
        title="Explanations, written once for the set"
        description="The whole proposal set is explained in one pass, before anybody opens a row — the same discipline the advisories follow, so the demo does not depend on a live burst of calls at the moment it is judged. Every figure in a written rationale is one the proposal already carries; the grounded schema refuses an invented number and a citation that names nothing."
      >
        {rationales === null ? (
          <p className="text-sm text-ink-muted" data-testid="rationale-pending">
            {rationaleBusy
              ? 'Asking the writer for a rationale per proposal…'
              : 'No rationale read has happened yet.'}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-card border border-hairline bg-paper-raised px-3 py-2 text-sm text-ink-muted"
              data-testid="rationale-summary"
            >
              <span>
                Writer <span className="font-mono text-accent">{rationales.provider}</span>
              </span>
              <span>
                proposals <span className="font-mono">{number(rationales.proposals)}</span>
              </span>
              <span>
                attempted <span className="font-mono">{number(rationales.attempted)}</span>
              </span>
              <span className="text-signal-ok">
                written <span className="font-mono">{number(rationales.written)}</span>
              </span>
              <span className="text-signal-watch">
                refused <span className="font-mono">{number(rationales.refused)}</span>
              </span>
              <span className="text-xs text-ink-subtle">
                {rationales.regenerated
                  ? `written by this read in ${number(rationales.generatedInMs)} ms, at ${rationales.generatedAt}`
                  : `answered from this process; the set was written at ${rationales.generatedAt}`}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                className="inline-flex min-h-11 items-center rounded-full border-2 border-accent/40 bg-accent/10 px-4 text-sm text-accent transition-colors duration-150 hover:bg-accent/20 disabled:pointer-events-none disabled:opacity-40"
                data-testid="rationale-regenerate"
                disabled={rationaleBusy}
                onClick={() => {
                  void loadRationales(true);
                }}
                type="button"
              >
                Ask the writer again
              </button>
              <span className="text-xs text-ink-subtle">
                A refusal is a result, not a failure: with no reasoning provider configured every
                proposal above shows the writer&apos;s own sentence instead of prose, and the
                proposal keeps its figures rather than losing them to a writer that could not
                explain them.
              </span>
            </div>

            {rationaleResult === null ? null : (
              <p className="text-sm text-accent" data-testid="rationale-result">
                {rationaleResult}
              </p>
            )}
          </div>
        )}
      </Panel>

      <Panel
        eyebrow="Accountability"
        id="audit"
        title="Audit trail"
        description="The decisions people have taken, in a hash-chained record: each entry carries the digest of the one before it, so removing an entry or altering a reason breaks the chain at the point of the change. The chain is recomputed here rather than asserted — a reader is shown whether the trail holds, not told that it does."
      >
        <div
          className="rounded-card border border-hairline bg-paper-raised px-3 py-2 text-sm text-ink-muted"
          data-testid="audit-chain"
          data-valid={payload.audit.valid ? 'yes' : 'no'}
        >
          <p>
            {payload.audit.valid ? (
              <span className="text-signal-ok">The chain holds.</span>
            ) : (
              <span className="text-signal-critical">
                The chain is broken at {payload.audit.brokenAt ?? 'an unknown entry'}.
              </span>
            )}{' '}
            {payload.audit.detail}
          </p>
        </div>

        {payload.auditEvents.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted" data-testid="audit-empty">
            Nothing has been decided in this process yet. The first decision will be the first link
            in the chain.
          </p>
        ) : (
          <ol className="mt-3 flex flex-col gap-2" data-testid="audit-events">
            {payload.auditEvents.map((event) => (
              <li
                key={event.id}
                data-audit-action={event.action}
                data-testid="audit-event"
                className="rounded-card border border-hairline bg-paper/60 px-3 py-2 text-xs text-ink-muted"
              >
                <p>
                  <span className="font-mono text-ink">{event.id}</span> · {event.action} ·{' '}
                  {event.subjectId}
                </p>
                <p className="mt-1">
                  {event.actorUid} ({event.actorRole}) at {event.occurredAt} —{' '}
                  {event.reason ?? 'no reason recorded'}
                </p>
                <p className="mt-1 font-mono text-ink-subtle">
                  {event.hash.slice(0, 16)}… ←{' '}
                  {event.previousHash?.slice(0, 16) ?? 'start of chain'}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel
        eyebrow="Refusals"
        id="why-not"
        title="Why not the obvious donor"
        description="The plan is a choice, and a choice is only explainable if the rejected candidates are visible: donors that could not help, receivers nothing could serve, and the graph's own account of the pairs it removed and why. What happens if nothing moves is the baseline objective beside the plan's."
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-card border border-hairline bg-paper-raised px-3 py-2 text-xs text-ink-muted">
            <p className="text-ink-muted">
              Graph: {number(payload.graph.candidates)} candidate pair(s) →{' '}
              {number(payload.graph.edges)} feasible edge(s)
            </p>
            <ul className="mt-1">
              {Object.entries(payload.graph.removedByRule).map(([rule, count]) => (
                <li key={rule}>
                  removed by <span className="font-mono">{rule}</span>: {number(count)}
                </li>
              ))}
            </ul>
            <p className="mt-1">
              Rankings: {number(payload.rankings.receiversRanked)} receiver(s) ranked ·{' '}
              {number(payload.rankings.receiversUnmeasured)} unmeasured ·{' '}
              {number(payload.rankings.donorsEligible)} donor(s) eligible ·{' '}
              {number(payload.rankings.needs)} need(s) found ·{' '}
              {number(payload.rankings.unpositionedReceivers)} receiver(s) without a position
            </p>
            <p className="mt-1">
              What happens if nothing moves: baseline{' '}
              <span className="font-mono">{decimal(payload.baseline.total)}</span> → plan{' '}
              <span className="font-mono">{decimal(payload.objective.total)}</span> over{' '}
              {number(payload.improvementPasses)} improvement pass(es). The objective is scaled to
              the most urgent receiver in this request and is not comparable between requests.
            </p>
            <p className="mt-1">
              Policy: reaction buffer {number(payload.transport.reactionBufferDays)} day(s) · edge
              capacity {number(payload.transport.edgeCapacityUnits)} unit(s) · budget{' '}
              {number(payload.transport.budgetUnitKm)} unit-km
            </p>
          </div>

          <div className="flex flex-col gap-2 text-xs text-ink-muted">
            <div>
              <p className="text-ink-muted">Donors that could not help</p>
              {payload.ineligibleDonors.length === 0 ? (
                <p>none — every donor with stock had something to give under the floor</p>
              ) : (
                <ul className="mt-1">
                  {payload.ineligibleDonors.map((donor) => (
                    <li key={`${donor.facilityName}|${donor.itemName}`}>
                      {donor.facilityName} · {donor.itemName} — {donor.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-ink-muted">Receivers nothing could serve</p>
              {payload.unserved.length === 0 ? (
                <p>none — every need found a donor inside the window</p>
              ) : (
                <ul className="mt-1">
                  {payload.unserved.map((need) => (
                    <li key={`${need.facilityName}|${need.itemName}`}>
                      {need.facilityName} · {need.itemName} — {number(need.units)} unit(s) —{' '}
                      {need.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-ink-muted">Receivers the forecast could not rank</p>
              {payload.unmeasuredReceivers.length === 0 ? (
                <p>none — every receiver had a measured shortfall probability</p>
              ) : (
                <ul className="mt-1">
                  {payload.unmeasuredReceivers.map((receiver) => (
                    <li key={`${receiver.facilityName}|${receiver.itemName}`}>
                      {receiver.facilityName} · {receiver.itemName} — {receiver.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </Panel>

      <p className="text-xs text-ink-subtle">
        Impact method <span className="font-mono">{payload.impactMethod}</span>: the forecast&apos;s
        median and upper paths over {number(payload.impactAssumptions.horizonDays)} day(s),{' '}
        {payload.impactAssumptions.weightedByShortfallProbability
          ? 'weighted by the measured shortfall probability'
          : 'unweighted — no shortfall probability was measured for these pairs'}
        . {payload.totals.unquantified} transfer(s) could not be quantified and are reported as
        unquantified rather than as zero. All data the platform shows is simulated; a decision about
        a proposal is a real act recorded in the chain, and neither label stands in for the other.
      </p>
    </div>
  );
}
