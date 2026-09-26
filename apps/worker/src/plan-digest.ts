import { createHash } from 'node:crypto';

import type { DateOnly } from '@civora/domain';
import type {
  PlanObjective,
  PlanRefusal,
  PlanVerdict,
  RedistributionPlan,
  StrategyName,
  TransferImpact,
} from '@civora/optimizer';

/**
 * The digest of a redistribution plan.
 *
 * The phase's determinism claim is that identical inputs produce byte-identical
 * plans across repeated runs **and across process restarts**, and no vitest file
 * can supply a restart: every test shares one process. What can supply one is a
 * command that rebuilds the plan from the seeded dataset, writes it down in a
 * fixed form, and is run twice. This module is that fixed form, and the command
 * beside it (`propose.ts`) is the restart.
 *
 * Three decisions make the block usable as evidence rather than as output:
 *
 *  - **Every number is printed exactly as computed.** A digest that rounded —
 *    to a tenth, or to a rupee — would let a real drift between two runs pass
 *    unnoticed, which is the one thing it exists to catch. The readable summary
 *    the command prints beside it is rounded for a person; this block is not.
 *  - **The block is canonical.** Fixed line order, sorted rule names, one field
 *    per line, and no clock or elapsed time anywhere: two plans that differ are
 *    seen to differ, and two that do not are byte-identical.
 *  - **It names its own format.** `civora-plan-digest@1` travels in the block
 *    *and* inside the hash, so a digest written by a different version cannot be
 *    compared with this one by accident.
 */

/** The digest's own version. It is part of the hashed block, not a comment. */
export const PLAN_DIGEST_FORMAT = 'civora-plan-digest@1';

/** The shape of the world the plan was computed from, counted. */
export interface PlanDigestDataset {
  readonly facilities: number;
  readonly districts: number;
  /** Facilities the generated history covers — the ones a plan can start from. */
  readonly withHistory: number;
  readonly items: number;
  readonly ledgerEntries: number;
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly days: number;
}

/** One proposal as the digest covers it: the record and the transfer behind it. */
export interface PlanDigestProposal {
  readonly id: string;
  readonly itemId: string;
  readonly fromFacilityId: string;
  readonly toFacilityId: string;
  readonly batchId: string | null;
  readonly quantity: number;
  readonly distanceKm: number;
  readonly leadTimeDays: number;
  readonly shelfLifeOnArrivalDays: number;
  readonly expiresOn: DateOnly;
  readonly coldChain: boolean;
  readonly verdict: string;
  readonly expectedImpact: {
    readonly unmetDemandAvoided: number;
    readonly donorDaysOfStockAfter: number;
    readonly receiverDaysOfStockAfter: number;
  };
  /** The estimator's own verdict, or null when no forecast covered the pair. */
  readonly impact: TransferImpact['assessment'] | null;
}

export interface PlanDigestFacts {
  readonly asOf: DateOnly;
  readonly seed: string;
  readonly scenarioId: string;
  readonly dataset: PlanDigestDataset;
  readonly objective: PlanObjective;
  readonly baseline: PlanObjective;
  readonly strategy: {
    readonly name: StrategyName;
    readonly decidedBy: 'model' | 'fallback';
    readonly benefitPerUnitKm: number;
    readonly reason: string;
    readonly iterations: number;
    readonly budgetReached: boolean;
  };
  readonly outcome: {
    readonly admitted: boolean;
    readonly violations: number;
    readonly unchecked: number;
    readonly measured: PlanVerdict['measured'];
  };
  readonly graph: {
    readonly candidates: number;
    readonly edges: number;
    readonly removedByRule: Readonly<Record<string, number>>;
  };
  readonly proposals: readonly PlanDigestProposal[];
  readonly refusals: readonly PlanRefusal[];
  readonly unserved: readonly {
    readonly facilityId: string;
    readonly itemId: string;
    readonly units: number;
  }[];
}

export interface PlanDigest {
  readonly format: string;
  /** `sha256:` followed by the digest of the canonical lines below. */
  readonly hash: string;
  /** The canonical block, unindented: what the hash is taken over. */
  readonly lines: readonly string[];
  /** The block as it is printed: the hash first, then the canonical lines. */
  readonly text: string;
}

/** What the digest needs that the plan itself does not carry. */
export interface PlanDigestContext {
  readonly seed: string;
  readonly scenarioId: string;
  readonly dataset: PlanDigestDataset;
}

/**
 * Every fact the digest covers, read off one plan.
 *
 * The `asOf` comes from the plan's own validation world rather than from the
 * caller, so a digest can never claim a day the plan was not made for.
 */
export function digestFactsOf(
  plan: RedistributionPlan,
  context: PlanDigestContext,
): PlanDigestFacts {
  return {
    asOf: plan.world.asOf,
    seed: context.seed,
    scenarioId: context.scenarioId,
    dataset: context.dataset,
    objective: plan.objective,
    baseline: plan.baseline,
    strategy: {
      name: plan.selection.name,
      decidedBy: plan.selection.decidedBy,
      benefitPerUnitKm: plan.selection.outcome.benefitPerUnitKm,
      reason: plan.selection.reason,
      iterations: plan.iterations,
      budgetReached: plan.budgetReached,
    },
    outcome: {
      admitted: plan.refused.length === 0,
      violations: plan.refused.length,
      unchecked: plan.selection.outcome.verdict.unchecked.length,
      measured: plan.selection.outcome.verdict.measured,
    },
    graph: {
      candidates:
        plan.graph.edges.length +
        Object.values(plan.graph.removedByRule).reduce((sum, count) => sum + count, 0),
      edges: plan.graph.edges.length,
      removedByRule: plan.graph.removedByRule,
    },
    proposals: plan.proposals.map((planned) => ({
      id: planned.proposal.id,
      itemId: planned.proposal.itemId,
      fromFacilityId: planned.proposal.fromFacilityId,
      toFacilityId: planned.proposal.toFacilityId,
      batchId: planned.proposal.batchId,
      quantity: planned.proposal.quantity,
      distanceKm: planned.transfer.distanceKm,
      leadTimeDays: planned.transfer.leadTimeDays,
      shelfLifeOnArrivalDays: planned.transfer.shelfLifeOnArrivalDays,
      expiresOn: planned.transfer.expiresOn,
      coldChain: planned.transfer.coldChain,
      verdict: planned.proposal.verdict,
      expectedImpact: {
        unmetDemandAvoided: planned.proposal.expectedImpact.unmetDemandAvoided,
        donorDaysOfStockAfter: planned.proposal.expectedImpact.donorDaysOfStockAfter,
        receiverDaysOfStockAfter: planned.proposal.expectedImpact.receiverDaysOfStockAfter,
      },
      impact: planned.impact?.assessment ?? null,
    })),
    refusals: plan.refused,
    unserved: plan.unserved.map((need) => ({
      facilityId: need.facilityId,
      itemId: need.itemId,
      units: need.units,
    })),
  };
}

/**
 * A sentence written onto one line.
 *
 * The strategy's reason and the validator's details are prose, and prose that
 * happened to contain a newline would break the one-field-per-line form the
 * digest is compared in. Collapsing whitespace is the smallest fix that keeps a
 * caller free to punctuate; nothing about the words changes.
 */
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

const objectiveLine = (label: string, objective: PlanObjective): string =>
  `${label} unmetDemandPenalty=${String(objective.unmetDemandPenalty)} transportCost=${String(
    objective.transportCost,
  )} expiryPenalty=${String(objective.expiryPenalty)} total=${String(objective.total)}`;

const removedLine = (removed: Readonly<Record<string, number>>): string =>
  Object.entries(removed)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([rule, count]) => `${rule}:${String(count)}`)
    .join(',');

/** The unserved needs, hashed rather than listed: see the line that prints it. */
const unservedHash = (unserved: PlanDigestFacts['unserved']): string => {
  const lines = unserved.map(
    (need) =>
      `unserved facility=${need.facilityId} item=${need.itemId} units=${String(need.units)}`,
  );
  return `sha256:${createHash('sha256')
    .update(`${lines.join('\n')}\n`)
    .digest('hex')}`;
};

const proposalLine = (proposal: PlanDigestProposal): string =>
  [
    `transfer id=${proposal.id}`,
    `item=${proposal.itemId}`,
    `from=${proposal.fromFacilityId}`,
    `to=${proposal.toFacilityId}`,
    `batch=${proposal.batchId ?? 'none'}`,
    `quantity=${String(proposal.quantity)}`,
    `distanceKm=${String(proposal.distanceKm)}`,
    `leadTimeDays=${String(proposal.leadTimeDays)}`,
    `shelfLifeOnArrivalDays=${String(proposal.shelfLifeOnArrivalDays)}`,
    `expiresOn=${proposal.expiresOn}`,
    `coldChain=${String(proposal.coldChain)}`,
    `verdict=${proposal.verdict}`,
    `expectedUnmetDemandAvoided=${String(proposal.expectedImpact.unmetDemandAvoided)}`,
    `donorDaysAfter=${String(proposal.expectedImpact.donorDaysOfStockAfter)}`,
    `receiverDaysAfter=${String(proposal.expectedImpact.receiverDaysOfStockAfter)}`,
    `impact=${proposal.impact ?? 'unquantified'}`,
  ].join(' ');

/** Write one plan down the same way every time, and hash what was written. */
export function digestOf(facts: PlanDigestFacts): PlanDigest {
  const lines = [
    `format ${PLAN_DIGEST_FORMAT}`,
    `as-of ${facts.asOf}`,
    `seed ${facts.seed}`,
    `scenario ${facts.scenarioId}`,
    `dataset facilities=${String(facts.dataset.facilities)} districts=${String(
      facts.dataset.districts,
    )} withHistory=${String(facts.dataset.withHistory)} items=${String(
      facts.dataset.items,
    )} ledgerEntries=${String(facts.dataset.ledgerEntries)} window=${facts.dataset.from}..${
      facts.dataset.to
    } days=${String(facts.dataset.days)}`,
    objectiveLine('objective', facts.objective),
    objectiveLine('baseline', facts.baseline),
    `strategy name=${facts.strategy.name} decidedBy=${facts.strategy.decidedBy} benefitPerUnitKm=${String(
      facts.strategy.benefitPerUnitKm,
    )} iterations=${String(facts.strategy.iterations)} budgetReached=${String(
      facts.strategy.budgetReached,
    )}`,
    `strategy-reason ${oneLine(facts.strategy.reason)}`,
    `outcome admitted=${String(facts.outcome.admitted)} violations=${String(
      facts.outcome.violations,
    )} unchecked=${String(facts.outcome.unchecked)} transfers=${String(
      facts.outcome.measured.transfers,
    )} units=${String(facts.outcome.measured.units)} unitKm=${String(
      facts.outcome.measured.unitKm,
    )}`,
    `graph candidates=${String(facts.graph.candidates)} edges=${String(
      facts.graph.edges,
    )} removed=${removedLine(facts.graph.removedByRule)}`,
    `proposals ${String(facts.proposals.length)}`,
    ...facts.proposals.map(proposalLine),
    `refusals ${String(facts.refusals.length)}`,
    ...facts.refusals.map(
      (refusal) =>
        `refusal rule=${refusal.rule} code=${refusal.code} detail=${oneLine(refusal.detail)}`,
    ),
    // A plan can leave hundreds of needs unserved in a dataset this size, and a
    // digest that printed every one of them would be unreadable — which is how a
    // digest stops being compared. The list is covered by its own hash instead:
    // any change to any need moves this line, and the reader who wants the names
    // has the plan report and the workbench.
    `unserved ${String(facts.unserved.length)} of ${unservedHash(facts.unserved)}`,
  ];

  const hash = `sha256:${createHash('sha256')
    .update(`${lines.join('\n')}\n`)
    .digest('hex')}`;

  return {
    format: PLAN_DIGEST_FORMAT,
    hash,
    lines,
    text: [`digest ${hash}`, ...lines.map((line) => `  ${line}`)].join('\n'),
  };
}
