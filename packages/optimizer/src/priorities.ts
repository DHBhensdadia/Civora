import type { EssentialityTier, FacilityId, ItemId } from '@civora/domain';

import { MAX_LEAD_TIME_DAYS } from './feasibility';

/**
 * Who needs stock, and who can spare it.
 *
 * The planner is a two-phase method: rank the receivers who need a transfer most,
 * then rank the donors who can supply them, then construct a plan, then improve
 * it locally. This module is the first phase, and it is the phase where a
 * platform earns or loses its credibility — a ranking that prefers the loudest
 * facility to the one with the most people at risk is a ranking that gets turned
 * off after the first bad week.
 *
 * Both ranking functions are written down as formulas with their terms named,
 * because "the optimiser decided" is not an explanation anybody can argue with:
 *
 *  - a **receiver** scores `shortfall probability × criticality × population at
 *    risk`, three quantities each of which is measured or read rather than
 *    chosen;
 *  - a **donor** scores `surplus above its own safety floor × expiry pressure`,
 *    which is the phase's "surplus above safety stock and imminent expiry" made
 *    arithmetic.
 *
 * Two disciplines carry over from the rest of the platform, and they are the
 * reason this module is worth reading rather than skimming:
 *
 *  - **A quantity that cannot be measured is `null`, and `null` is not zero.** A
 *    facility whose demand the platform cannot measure is not a facility with no
 *    demand, so it cannot be ranked as an urgent receiver *or* ranked as an
 *    inexhaustible donor. It is reported as unmeasured and left out of both
 *    lists, on the surface, where a person can act on it.
 *  - **A facility whose demand is unmeasured cannot donate at all.** Its safety
 *    floor is unknown, so any quantity it gave away would be a quantity the
 *    platform had no basis for calling spare. This is the property the phase's
 *    blocking test exists for, enforced here before a plan is ever built.
 */

// --- The floor -------------------------------------------------------------

/**
 * Days of its own demand a facility keeps when it gives stock away.
 *
 * The floor is not "whatever is left over". A facility that gives away stock it
 * needs is a facility with no cushion against its own next delay, and a
 * redistribution that prevents one stock-out by causing another is worse than no
 * redistribution at all. So a donor keeps its demand over the replenishment
 * window it would need to survive on an order, plus a week of slippage.
 *
 * Twelve days in total against the platform's seven-day critical-cover figure,
 * and the gap is deliberate: it is what stops the planner from stripping a donor
 * down to the point where *it* becomes the next critical facility.
 */
export const SAFETY_COVER_BUFFER_DAYS = 7;

/**
 * The stock a facility of this demand must keep to itself.
 *
 * Zero demand is a measurable zero and gives a zero floor — an item nobody
 * dispenses here is not stock the facility needs. Unmeasurable demand is a
 * different answer and produces `null`, which is why the argument is nullable and
 * the return is too.
 */
export function safetyStockFor(input: {
  readonly dailyDemand: number | null;
  readonly leadTimeDays?: number | undefined;
}): number | null {
  if (input.dailyDemand === null) {
    return null;
  }
  const leadTimeDays = input.leadTimeDays ?? MAX_LEAD_TIME_DAYS;
  return Math.ceil(input.dailyDemand * (leadTimeDays + SAFETY_COVER_BUFFER_DAYS));
}

// --- Receivers -------------------------------------------------------------

/**
 * How much worse it is for a facility to be without the item.
 *
 * An essential item is three times a supplementary one, which is a stated
 * weighting rather than a measured one: the national list's own tiers are
 * ordinal, and the platform has no evidence that the gap between them is any
 * particular size. Stating the weights is what makes them arguable.
 */
export const CRITICALITY_WEIGHTS: Readonly<Record<EssentialityTier, number>> = {
  essential: 3,
  programme: 2,
  supplementary: 1,
};

export interface ReceiverPriority {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  /**
   * `probability × criticality × population at risk`.
   *
   * `null` when the forecast measured no shortfall probability for this pair:
   * an unmeasurable pair is reported as unmeasured rather than ranked as calm,
   * because a facility the platform cannot see is not a facility with full
   * shelves — the same rule the visibility surface enforces, applied to a plan.
   */
  readonly priority: number | null;
  readonly shortfallProbability: number | null;
  readonly criticality: number;
  readonly populationAtRisk: number;
  readonly basis: ReceiverBasis;
}

/** Which of the three terms was missing, when one was. */
export type ReceiverBasis = 'measured' | 'probability-not-forecast';

export function receiverPriorityOf(input: {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly shortfallProbability: number | null;
  readonly essentiality: EssentialityTier;
  /** People the facility is responsible for. The exposure if the shelf empties. */
  readonly populationAtRisk: number;
}): ReceiverPriority {
  const criticality = CRITICALITY_WEIGHTS[input.essentiality];

  if (input.shortfallProbability === null) {
    return {
      facilityId: input.facilityId,
      itemId: input.itemId,
      priority: null,
      shortfallProbability: null,
      criticality,
      populationAtRisk: input.populationAtRisk,
      basis: 'probability-not-forecast',
    };
  }

  return {
    facilityId: input.facilityId,
    itemId: input.itemId,
    priority: input.shortfallProbability * criticality * input.populationAtRisk,
    shortfallProbability: input.shortfallProbability,
    criticality,
    populationAtRisk: input.populationAtRisk,
    basis: 'measured',
  };
}

export interface RankedReceiver extends ReceiverPriority {
  /**
   * Never `null` here: a pair with no measured probability is not ranked at all.
   *
   * The narrowing is the whole reason the ranked and unranked halves are separate
   * lists rather than one list with a nullable score — anything downstream of a
   * ranking can then treat a score as a number, and the one place an unknown can
   * enter is the check that produced it.
   */
  readonly priority: number;
  /** Position in the ranked list, from one. Ties are broken by facility, then item. */
  readonly rank: number;
}

export interface ReceiverRanking {
  /** Measurably at risk, most urgent first, each carrying its position. */
  readonly ranked: readonly RankedReceiver[];
  /** Pairs the forecast did not measure. Reported, never ranked. */
  readonly unmeasured: readonly ReceiverPriority[];
}

/**
 * Receivers in the order the planner should try to serve them.
 *
 * Sorting is by score, then by facility and item, so two runs over the same
 * inputs produce the same order — the determinism the audit trail depends on
 * starts here rather than at the solver.
 */
export function rankReceivers(positions: readonly ReceiverPriority[]): ReceiverRanking {
  const measured = positions.filter(
    (position): position is ReceiverPriority & { readonly priority: number } =>
      position.priority !== null,
  );
  const unmeasured = positions.filter((position) => position.priority === null);

  const ranked = [...measured]
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        compareText(left.facilityId, right.facilityId) ||
        compareText(left.itemId, right.itemId),
    )
    .map((position, index): RankedReceiver => ({
      ...position,
      priority: position.priority,
      rank: index + 1,
    }));

  unmeasured.sort(
    (left, right) =>
      compareText(left.facilityId, right.facilityId) || compareText(left.itemId, right.itemId),
  );

  return { ranked, unmeasured };
}

// --- Donors ----------------------------------------------------------------

/**
 * How much more urgent it is to move a batch that is about to expire.
 *
 * A multiplicative weight between one and two: a batch with a year on it carries
 * no extra pressure, and one expiring today is worth twice the same quantity with
 * time to spare. Bounded above deliberately — expiry is a reason to move stock
 * *before* something better, never a reason to move it somewhere it is not
 * needed, and an unbounded term would swamp the benefit of the transfer itself.
 */
export const EXPIRY_PRESSURE_HORIZON_DAYS = 90;
export const EXPIRY_PRESSURE_MAX = 2;

export type DonorBasis =
  /** Above its floor, with a measurable demand behind the floor. */
  | 'surplus'
  /** Demand has never been measured here, so no floor can be computed. */
  | 'demand-unmeasured'
  /** Everything it holds is inside the floor it keeps for itself. */
  | 'at-or-below-floor';

export interface DonorPriority {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly onHand: number;
  /** The floor this facility keeps for itself; `null` when unmeasurable. */
  readonly safetyStock: number | null;
  /** Units above the floor. Zero when the floor is unknown — never the whole shelf. */
  readonly surplus: number;
  /** Days until the facility's earliest batch expires; `null` when none is known. */
  readonly earliestExpiryDays: number | null;
  readonly expiryPressure: number;
  /**
   * `surplus × expiry pressure`, or `null` when there is no floor to measure
   * against. `null` is not a low score: it means this facility may not be drawn
   * on, and the reason is carried in `basis`.
   */
  readonly priority: number | null;
  readonly basis: DonorBasis;
}

export function donorPriorityOf(input: {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly onHand: number;
  /** `null` when no daily rate could be measured for this facility and item. */
  readonly dailyDemand: number | null;
  /** `null` when the platform holds no batch expiry at this facility. */
  readonly earliestExpiryDays: number | null;
  readonly leadTimeDays?: number | undefined;
}): DonorPriority {
  const expiryPressure = expiryPressureOf(input.earliestExpiryDays);
  const safetyStock = safetyStockFor({
    dailyDemand: input.dailyDemand,
    leadTimeDays: input.leadTimeDays,
  });

  if (safetyStock === null) {
    return {
      facilityId: input.facilityId,
      itemId: input.itemId,
      onHand: input.onHand,
      safetyStock: null,
      surplus: 0,
      earliestExpiryDays: input.earliestExpiryDays,
      expiryPressure,
      priority: null,
      basis: 'demand-unmeasured',
    };
  }

  const surplus = Math.max(0, input.onHand - safetyStock);

  return {
    facilityId: input.facilityId,
    itemId: input.itemId,
    onHand: input.onHand,
    safetyStock,
    surplus,
    earliestExpiryDays: input.earliestExpiryDays,
    expiryPressure,
    priority: surplus === 0 ? 0 : surplus * expiryPressure,
    basis: surplus === 0 ? 'at-or-below-floor' : 'surplus',
  };
}

/** The expiry weight for a batch with this much life left. */
export function expiryPressureOf(earliestExpiryDays: number | null): number {
  if (earliestExpiryDays === null || earliestExpiryDays >= EXPIRY_PRESSURE_HORIZON_DAYS) {
    return 1;
  }
  const urgency =
    (EXPIRY_PRESSURE_HORIZON_DAYS - Math.max(0, earliestExpiryDays)) / EXPIRY_PRESSURE_HORIZON_DAYS;
  return 1 + urgency * (EXPIRY_PRESSURE_MAX - 1);
}

export interface RankedDonor extends DonorPriority {
  /** Never `null` here: a donor with no computable floor is not ranked at all. */
  readonly priority: number;
  readonly rank: number;
}

export interface DonorRanking {
  /** Facilities with stock to spare, most useful first. */
  readonly ranked: readonly RankedDonor[];
  /** Facilities that may not be drawn on, with the reason, in a stable order. */
  readonly ineligible: readonly DonorPriority[];
}

export function rankDonors(positions: readonly DonorPriority[]): DonorRanking {
  const eligible = positions.filter(
    (position): position is DonorPriority & { readonly priority: number } =>
      position.priority !== null && position.priority > 0,
  );
  const ineligible = positions.filter(
    (position) => position.priority === null || position.priority === 0,
  );

  const ranked = [...eligible]
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        compareText(left.facilityId, right.facilityId) ||
        compareText(left.itemId, right.itemId),
    )
    .map((position, index): RankedDonor => ({
      ...position,
      priority: position.priority,
      rank: index + 1,
    }));

  ineligible.sort(
    (left, right) =>
      compareText(left.facilityId, right.facilityId) || compareText(left.itemId, right.itemId),
  );

  return { ranked, ineligible };
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
