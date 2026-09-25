import { addDays, daysBetween, transferProposalSchema } from '@civora/domain';
import type {
  DateOnly,
  EssentialityTier,
  FacilityId,
  ItemId,
  TransferProposal,
} from '@civora/domain';

import { buildTransferGraph } from './feasibility';
import type { StockLot, TransferGraph, TransferItem, TransferNode } from './feasibility';
import type { ReceiverDemand, TransferImpact } from './impact';
import type { PlannedTransfer, PlanObjective, TransferNeed, UnservedNeed } from './planner';
import {
  donorPriorityOf,
  rankDonors,
  rankReceivers,
  receiverPriorityOf,
  safetyStockFor,
} from './priorities';
import type { DonorRanking, ReceiverRanking } from './priorities';
import { proposePlan } from './strategy';
import type { StrategySelection, StrategySelector } from './strategy';
import { validatePlan } from './validator';
import type {
  DonorPosition,
  PlanViolation,
  ReceiverLimit,
  TransportLimits,
  ValidationWorld,
} from './validator';

/**
 * The whole redistribution pipeline, from a world to the records a workbench
 * shows.
 *
 * This is the module that turns the optimiser's own pieces into the contract the
 * rest of the platform consumes — `TransferProposal`, with its validity verdict,
 * its expected impact and its assumptions. It is pure: the caller supplies the
 * world, and nothing here reads a clock, a file or a database. That is what lets
 * the batch job and the surface run the *same* pipeline over the same dataset and
 * get the same records, which is the property the audit trail depends on.
 *
 * The separation of powers is unchanged and the ordering is the whole argument:
 *
 *  1. the **graph** decides which moves are physically possible at all;
 *  2. the **rankings** decide who needs stock and who can spare it;
 *  3. the **planner** allocates quantities, against one stated objective;
 *  4. the **validator** — a separate module, sharing no code with the planner —
 *     re-derives the plan from the world and refuses what it cannot admit;
 *  5. the **impact estimator** prices each admitted transfer against the
 *     forecasts, and reports a marginal or unpriced one as exactly that.
 *
 * A plan the validator refuses produces **no proposals at all**. That is the
 * phase's rule — a refused plan never reaches a human as something to approve —
 * and it is why `refused` travels beside `proposals` rather than a rejected row
 * being invented for a transfer the validator never objected to. What a refused
 * plan gets is a loud, attributed refusal: every violation with its own rule and
 * its own sentence, and every strategy's verdict beside it.
 */

/** One facility-item pair as the platform's stock projection reports it. */
export interface PairPosition {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly onHand: number;
  readonly inTransit: number;
}

/**
 * The parts of a scored pair this pipeline reads.
 *
 * Structural rather than imported from the forecasting engine on purpose: the
 * caller already has the scored population, and a pipeline that demanded its own
 * copy of the assessment shape could drift from the scores the platform shows.
 * An `Assessment` satisfies this without knowing it exists.
 */
export interface ScoredPair {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly forecast: { readonly p50: readonly number[]; readonly p90: readonly number[] };
  readonly risk: { readonly shortfallProbability: number | null };
}

/** A facility, plus the exposure the receiver ranking weights. */
export interface RedistributionFacility extends TransferNode {
  readonly catchmentPopulation: number;
}

/** A catalogue entry, plus the tier the receiver ranking weights. */
export interface RedistributionItem extends TransferItem {
  readonly essentiality: EssentialityTier;
}

/**
 * The bounds this build states rather than discovers.
 *
 * Every one is a policy number a reader can argue with, and each is stated once
 * so that the workbench, the batch job and the validator read the same value.
 * They are deliberately not tuned to a scenario: a bound that only holds for the
 * demonstration dataset is not a bound.
 */
export interface RedistributionPolicy {
  /** Days a receiver may be asked to wait past its own projected stock-out. */
  readonly reactionBufferDays: number;
  /** Unit-kilometres the plan may spend per unit it was asked to move, on average. */
  readonly maxAverageHaulKm: number;
  /** Units one vehicle carries along one edge. */
  readonly edgeCapacityUnits: number;
}

export const REDISTRIBUTION_POLICY: RedistributionPolicy = {
  // Two days of grace: a stock-out projected for Thursday is still preventible by
  // a load that lands on Saturday. A load that arrives after that is inventory,
  // not relief, and should be refused rather than praised for arriving.
  reactionBufferDays: 2,
  // The path rules already refuse any single journey longer than five days on
  // the road. This bound is about the plan as a whole: a solver that serves one
  // district from the far end of the country is refused even where each
  // individual journey is feasible.
  maxAverageHaulKm: 250,
  // One movement, one vehicle. Stated rather than measured, because the platform
  // has no fleet register to measure it from; the validator's own tests exercise
  // the refused case, and no lot in the demonstration dataset approaches it.
  edgeCapacityUnits: 10_000,
};

export interface RedistributionInput {
  readonly asOf: DateOnly;
  readonly facilities: readonly RedistributionFacility[];
  readonly items: readonly RedistributionItem[];
  readonly lots: readonly StockLot[];
  readonly positions: readonly PairPosition[];
  readonly scored: readonly ScoredPair[];
  readonly policy?: RedistributionPolicy | undefined;
}

/** A refusal of the plan as a whole, in the validator's own words. */
export interface PlanRefusal {
  readonly rule: PlanViolation['rule'];
  readonly code: string;
  readonly detail: string;
}

/** One admitted transfer, with the record built for it and its priced impact. */
export interface PlannedProposal {
  readonly proposal: TransferProposal;
  readonly transfer: PlannedTransfer;
  /** Null when no forecast covered the receiver and item. */
  readonly impact: TransferImpact | null;
}

export interface RedistributionPlan {
  readonly graph: TransferGraph;
  readonly receivers: ReceiverRanking;
  readonly donors: DonorRanking;
  readonly needs: readonly TransferNeed[];
  readonly demands: readonly ReceiverDemand[];
  readonly world: ValidationWorld;
  readonly selection: StrategySelection;
  readonly iterations: number;
  readonly budgetReached: boolean;
  /** One per transfer of the selected strategy, or empty when its plan was refused. */
  readonly proposals: readonly PlannedProposal[];
  /** The selected plan's violations, empty when it was admitted. */
  readonly refused: readonly PlanRefusal[];
  readonly objective: PlanObjective;
  readonly baseline: PlanObjective;
  readonly unserved: readonly UnservedNeed[];
  readonly improvementPasses: number;
  /** Scored pairs with no stock position at all, reported rather than assumed away. */
  readonly unpositionedReceivers: readonly {
    readonly facilityId: FacilityId;
    readonly itemId: ItemId;
  }[];
}

/** The key a caller builds its position and score lookups on. */
export const pairKey = (facilityId: FacilityId, itemId: ItemId): string =>
  `${facilityId}|${itemId}`;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** The mean daily rate a forecast's median path implies over its own horizon. */
export function dailyRateOf(p50: readonly number[]): number {
  if (p50.length === 0) {
    return 0;
  }
  return p50.reduce((total, value) => total + value, 0) / p50.length;
}

/**
 * The first day a receiver's stock runs out on the median path, or null.
 *
 * Day zero of the forecast is the day after `asOf`, so demand on the first day
 * that exceeds stock means the shelf empties that day. Null is a real answer —
 * "the median path does not exhaust it" — and is kept apart from a day, which is
 * what stops a projection from being read as a promise.
 */
export function stockOutOnFrom(input: {
  readonly asOf: DateOnly;
  readonly onHand: number;
  readonly p50: readonly number[];
}): DateOnly | null {
  let stock = input.onHand;

  for (let day = 0; day < input.p50.length; day += 1) {
    const demand = input.p50[day] ?? 0;
    if (demand > stock) {
      return addDays(input.asOf, day + 1);
    }
    stock -= demand;
  }

  return null;
}

/** The soonest expiry among the lots a facility holds of one item, in days. */
function earliestExpiryByPair(
  lots: readonly StockLot[],
  asOf: DateOnly,
): ReadonlyMap<string, number> {
  const earliest = new Map<string, number>();

  for (const lot of lots) {
    if (lot.quantity <= 0) {
      continue;
    }
    const key = pairKey(lot.facilityId, lot.itemId);
    const days = daysBetween(asOf, lot.expiresOn);
    const current = earliest.get(key);
    if (current === undefined || days < current) {
      earliest.set(key, days);
    }
  }

  return earliest;
}

export interface Groundwork {
  readonly graph: TransferGraph;
  readonly receivers: ReceiverRanking;
  readonly donors: DonorRanking;
  readonly needs: readonly TransferNeed[];
  readonly demands: readonly ReceiverDemand[];
  readonly receiverLimits: readonly ReceiverLimit[];
  readonly donorPositions: readonly DonorPosition[];
  readonly unpositionedReceivers: readonly {
    readonly facilityId: FacilityId;
    readonly itemId: ItemId;
  }[];
}

/**
 * Build the transfer graph, the two rankings, the needs and the world's half of
 * the validator's inputs.
 *
 * Separated from the planning itself so that a caller can report *why* a plan is
 * thin: a graph that removed everything by lead time and a ranking that found no
 * surplus are different problems, and a single "no transfers" answer would hide
 * which one occurred.
 */
export function redistributionGroundwork(input: {
  readonly asOf: DateOnly;
  readonly facilities: readonly RedistributionFacility[];
  readonly items: readonly RedistributionItem[];
  readonly lots: readonly StockLot[];
  readonly positions: readonly PairPosition[];
  readonly scored: readonly ScoredPair[];
}): Groundwork {
  const { asOf } = input;
  const graph = buildTransferGraph({
    nodes: input.facilities,
    items: input.items,
    lots: input.lots,
    options: { asOf },
  });

  const itemById = new Map(input.items.map((item) => [item.itemId as string, item]));
  const facilityById = new Map(
    input.facilities.map((facility) => [facility.facilityId as string, facility]),
  );
  const positionByKey = new Map(
    input.positions.map((position) => [pairKey(position.facilityId, position.itemId), position]),
  );
  const expiryByKey = earliestExpiryByPair(input.lots, asOf);
  const scoredByKey = new Map(
    input.scored.map((pair) => [pairKey(pair.facilityId, pair.itemId), pair]),
  );

  // Receivers: every scored pair whose shelf the platform can see. A pair with a
  // forecast and no position is reported rather than treated as an empty shelf —
  // a missing reading is not a stock-out.
  const receiverPriorities = [];
  const unpositionedReceivers: { facilityId: FacilityId; itemId: ItemId }[] = [];

  for (const pair of input.scored) {
    const position = positionByKey.get(pairKey(pair.facilityId, pair.itemId));
    const item = itemById.get(pair.itemId);
    const facility = facilityById.get(pair.facilityId);
    if (position === undefined || item === undefined || facility === undefined) {
      unpositionedReceivers.push({ facilityId: pair.facilityId, itemId: pair.itemId });
      continue;
    }
    receiverPriorities.push(
      receiverPriorityOf({
        facilityId: pair.facilityId,
        itemId: pair.itemId,
        shortfallProbability: pair.risk.shortfallProbability,
        essentiality: item.essentiality,
        populationAtRisk: facility.catchmentPopulation,
      }),
    );
  }

  const receivers = rankReceivers(receiverPriorities);

  // Needs and caps, measured against stock on hand **plus stock already on its
  // way**: a facility with 40 units arriving tomorrow does not need 40 units sent
  // today, and a platform that ignored the order it already watched being placed
  // would be ordering the same thing twice.
  const needs: TransferNeed[] = [];
  const receiverLimits: ReceiverLimit[] = [];

  for (const receiver of receivers.ranked) {
    const pair = scoredByKey.get(pairKey(receiver.facilityId, receiver.itemId));
    const position = positionByKey.get(pairKey(receiver.facilityId, receiver.itemId));
    if (pair === undefined || position === undefined) {
      continue;
    }
    const rate = dailyRateOf(pair.forecast.p50);
    const target = safetyStockFor({ dailyDemand: rate }) ?? 0;
    const available = position.onHand + position.inTransit;
    const units = Math.max(0, Math.ceil(target - available));

    receiverLimits.push({
      facilityId: receiver.facilityId,
      itemId: receiver.itemId,
      capacityUnits: units,
      projectedStockOutOn: stockOutOnFrom({
        asOf,
        onHand: position.onHand,
        p50: pair.forecast.p50,
      }),
    });

    if (units > 0) {
      needs.push({ facilityId: receiver.facilityId, itemId: receiver.itemId, units });
    }
  }

  // Donors: every pair the platform holds a position for. A pair whose demand the
  // forecast never measured carries `dailyDemand: null` — it cannot donate at
  // all, and the validator refuses it rather than trusting the ranking to.
  const donorPriorities = [];
  const donorPositions: DonorPosition[] = [];

  for (const position of input.positions) {
    const pair = scoredByKey.get(pairKey(position.facilityId, position.itemId));
    const dailyDemand = pair === undefined ? null : dailyRateOf(pair.forecast.p50);

    donorPositions.push({
      facilityId: position.facilityId,
      itemId: position.itemId,
      dailyDemand,
    });
    donorPriorities.push(
      donorPriorityOf({
        facilityId: position.facilityId,
        itemId: position.itemId,
        onHand: position.onHand,
        dailyDemand,
        earliestExpiryDays: expiryByKey.get(pairKey(position.facilityId, position.itemId)) ?? null,
      }),
    );
  }

  const donors = rankDonors(donorPriorities);

  const demands: ReceiverDemand[] = [];
  for (const pair of input.scored) {
    const position = positionByKey.get(pairKey(pair.facilityId, pair.itemId));
    if (position === undefined) {
      continue;
    }
    demands.push({
      facilityId: pair.facilityId,
      itemId: pair.itemId,
      // The projection starts from what the facility holds today; stock on its
      // way is not modelled as an arrival, which the assumptions say.
      onHandUnits: position.onHand,
      p50: pair.forecast.p50,
      p90: pair.forecast.p90,
      shortfallProbability: pair.risk.shortfallProbability,
    });
  }

  return {
    graph,
    receivers,
    donors,
    needs,
    demands,
    receiverLimits,
    donorPositions,
    unpositionedReceivers,
  };
}

/**
 * Run the pipeline: groundwork, the strategy loop, the validator, the impact.
 *
 * The strategy selector is optional and, with no provider configured, absent —
 * in which case `proposePlan` runs its deterministic fallback, which is the
 * shipped decision rule rather than a placeholder. A selector, when one exists,
 * may name a strategy; it can never supply a quantity the validator has not
 * admitted.
 */
export async function planRedistribution(
  input: RedistributionInput,
  options: { readonly select?: StrategySelector | undefined } = {},
): Promise<RedistributionPlan> {
  const policy = input.policy ?? REDISTRIBUTION_POLICY;
  const groundwork = redistributionGroundwork(input);

  const needsUnits = groundwork.needs.reduce((total, need) => total + need.units, 0);
  const transport: TransportLimits = {
    // A budget per unit asked for, so the bound scales with the request instead
    // of being a number that happens to fit one dataset.
    budgetUnitKm: Math.max(1, needsUnits) * policy.maxAverageHaulKm,
    edgeCapacityUnits: policy.edgeCapacityUnits,
    reactionBufferDays: policy.reactionBufferDays,
  };

  const base = {
    asOf: input.asOf,
    edges: groundwork.graph.edges,
    receivers: groundwork.receivers,
    donors: groundwork.donors,
    needs: groundwork.needs,
  };

  const world: ValidationWorld = {
    asOf: input.asOf,
    facilities: input.facilities,
    items: input.items,
    lots: input.lots,
    donorPositions: groundwork.donorPositions,
    receiverLimits: groundwork.receiverLimits,
    transport,
  };

  const planned = await proposePlan({
    set: { base, demands: groundwork.demands, world },
    ...(options.select === undefined ? {} : { select: options.select }),
  });

  const outcome = planned.selection.outcome;
  const facts = pairFactsOf({ positions: input.positions, scored: input.scored });
  const { proposals, refused } = proposalsFrom({
    selection: planned.selection,
    world,
    facts,
  });

  return {
    graph: groundwork.graph,
    receivers: groundwork.receivers,
    donors: groundwork.donors,
    needs: groundwork.needs,
    demands: groundwork.demands,
    world,
    selection: planned.selection,
    iterations: planned.iterations,
    budgetReached: planned.budgetReached,
    proposals,
    refused,
    objective: outcome.plan.objective,
    baseline: outcome.plan.baseline,
    unserved: outcome.plan.unserved,
    improvementPasses: outcome.plan.improvementPasses,
    unpositionedReceivers: groundwork.unpositionedReceivers,
  };
}

/** What a proposal needs to know about one pair: its shelf and its measured rate. */
export interface PairFacts {
  readonly onHand: number;
  readonly rate: number;
}

/** The pair facts a proposal's days-of-cover figures are computed from. */
export function pairFactsOf(input: {
  readonly positions: readonly PairPosition[];
  readonly scored: readonly ScoredPair[];
}): ReadonlyMap<string, PairFacts> {
  const rateByKey = new Map(
    input.scored.map((pair) => [
      pairKey(pair.facilityId, pair.itemId),
      dailyRateOf(pair.forecast.p50),
    ]),
  );

  return new Map(
    input.positions.map((position) => [
      pairKey(position.facilityId, position.itemId),
      {
        onHand: position.onHand,
        rate: rateByKey.get(pairKey(position.facilityId, position.itemId)) ?? 0,
      },
    ]),
  );
}

/**
 * The proposals the selected plan earns, or the refusals that stop it.
 *
 * Every number the record carries was computed by the optimiser: the quantity by
 * the planner, the distance and lead time by the graph, the avoided demand by the
 * impact estimator. The only things decided here are what to print and which of
 * the estimator's assumptions travel with the figure.
 *
 * The validator is run *again* here rather than trusted from the evaluation, so
 * that what the record says was checked is what was checked at the moment the
 * record was built.
 */
export function proposalsFrom(input: {
  readonly selection: StrategySelection;
  readonly world: ValidationWorld;
  readonly facts: ReadonlyMap<string, PairFacts>;
}): { readonly proposals: readonly PlannedProposal[]; readonly refused: readonly PlanRefusal[] } {
  const outcome = input.selection.outcome;
  const verdict = validatePlan(outcome.plan.transfers, input.world);

  if (!verdict.valid) {
    return {
      proposals: [],
      refused: verdict.violations.map((violation) => ({
        rule: violation.rule,
        code: violation.code,
        detail: violation.detail,
      })),
    };
  }

  const impactByKey = new Map(
    outcome.impact.transfers.map((impact) => [movementKey(impact), impact]),
  );

  const proposals = outcome.plan.transfers.map((transfer): PlannedProposal => {
    const impact = impactByKey.get(movementKey(transfer)) ?? null;
    const donor = input.facts.get(pairKey(transfer.donorId, transfer.itemId));
    const receiver = input.facts.get(pairKey(transfer.receiverId, transfer.itemId));
    const donorRate = donor?.rate ?? 0;
    const receiverRate = receiver?.rate ?? 0;

    return {
      proposal: transferProposalSchema.parse({
        id: proposalIdFor(transfer),
        itemId: transfer.itemId,
        fromFacilityId: transfer.donorId,
        toFacilityId: transfer.receiverId,
        quantity: transfer.quantity,
        batchId: transfer.batchId,
        verdict: 'proposed',
        violations: [],
        expectedImpact: {
          unmetDemandAvoided:
            impact === null ? 0 : Math.max(0, Math.round(impact.expectedUnmetDemandAvoided)),
          donorDaysOfStockAfter: daysOfStockAfter({
            units: (donor?.onHand ?? 0) - transfer.quantity,
            rate: donorRate,
          }),
          receiverDaysOfStockAfter: daysOfStockAfter({
            units: (receiver?.onHand ?? 0) + transfer.quantity,
            rate: receiverRate,
          }),
          assumptions: assumptionsFor({ impact, selection: input.selection, transfer }),
        },
        // A person's decisions are appended here, and nowhere else. The chain in
        // the audit trail carries the same decisions independently.
        approvals: [],
        // The world is generated; the proposal is derived from it.
        synthetic: true,
        provenance: { kind: 'derived', reference: 'redistribution-plan' },
      }),
      transfer,
      impact,
    };
  });

  return { proposals, refused: [] };
}

const movementKey = (movement: {
  readonly donorId: FacilityId;
  readonly receiverId: FacilityId;
  readonly itemId: ItemId;
  readonly batchId: string;
}): string => `${movement.donorId}|${movement.receiverId}|${movement.itemId}|${movement.batchId}`;

/** A stable identifier for one movement, so a rebuild addresses the same record. */
export function proposalIdFor(transfer: {
  readonly donorId: FacilityId;
  readonly receiverId: FacilityId;
  readonly itemId: ItemId;
  readonly batchId: string;
}): string {
  return `transfer:${transfer.donorId}:${transfer.receiverId}:${transfer.itemId}:${transfer.batchId}`;
}

/**
 * Days of cover a position amounts to, at a measured rate.
 *
 * A rate nobody measured has no answer. Zero is the domain's only non-negative
 * stand-in, and the assumptions say so rather than presenting it as a
 * measurement.
 */
function daysOfStockAfter(input: { readonly units: number; readonly rate: number }): number {
  if (input.rate <= 0) {
    return 0;
  }
  return round1(Math.max(0, input.units) / input.rate);
}

/**
 * The assumption set that travels with an impact figure.
 *
 * An estimate without its assumptions is a claim, which is what the domain's
 * `expectedImpact.assumptions` field exists to prevent. These are the estimator's
 * own stated method, its horizon and its weights, plus the two local facts that
 * decide what this particular number means: the load the projection added, and
 * whether the receiver's stock on its way was counted.
 */
function assumptionsFor(input: {
  readonly impact: TransferImpact | null;
  readonly selection: StrategySelection;
  readonly transfer: PlannedTransfer;
}): readonly string[] {
  const assumptions = input.selection.outcome.impact.assumptions;
  const shared = [
    `method: ${assumptions.method}`,
    `horizon: ${String(assumptions.horizonDays)} day(s) — the shortest horizon any priced transfer in this plan was projected over`,
    `transport priced at ${String(assumptions.costPerUnitKm)} per unit-kilometre, the planner's own weight`,
    assumptions.weightedByShortfallProbability
      ? "the receiver's measured shortfall probability weighted the two demand paths"
      : 'no measured shortfall probability weighted the paths, so the median path stands alone',
    'the receiver was measured against stock on hand plus stock already in transit, so an order on its way is not placed twice',
  ];

  if (input.impact === null) {
    return [
      ...shared,
      'no forecast is stored for this receiver and item, so no impact was estimated: the zero here is an absence, not a measured zero',
    ];
  }

  return [
    ...shared,
    `projected over ${String(input.impact.units)} unit(s) travelling ${String(input.impact.distanceKm)} km in ${String(input.impact.leadTimeDays)} day(s)`,
    `assessment: ${input.impact.assessment} — ${input.impact.note}`,
  ];
}
