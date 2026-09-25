import { daysBetween } from '@civora/domain';
import type { DateOnly, FacilityId, ItemId } from '@civora/domain';

import type { TransferEdge } from './feasibility';
import { expiryPressureOf } from './priorities';
import type { DonorRanking, ReceiverRanking } from './priorities';

/**
 * The planner: what to move, how much of it, and from where.
 *
 * The method is two-phase by design. **Construction** walks the receivers in the
 * order their ranking put them and gives each one the cheapest stock that can
 * reach it. **Local improvement** then looks for a better plan than greedy
 * produced, one move at a time, until no single move helps or the pass budget
 * runs out.
 *
 * The greedy phase is genuinely insufficient, which is why the second phase is
 * not decoration. A scarce batch is consumed by the first receiver who can use
 * it, even when a later receiver has *no other supplier at all* and the first
 * could have been served from a batch two kilometres further away. No sequence of
 * drops and increases fixes that — the fix is to move a delivery to another batch
 * so the scarce one is released — so the improvement phase has a **re-sourcing
 * move**, and that is the move the phase's own failure note is about: greedy
 * leaves stock in the wrong place, and a planner that cannot see it is a planner
 * that ships plausible nonsense.
 *
 * Every move is judged against one **objective**, stated once and computed once,
 * so nothing is decided by arithmetic different from the arithmetic the report
 * prints:
 *
 *   cost = unmet-demand penalty + transport cost + expiry penalty
 *
 * The weights are *relative*, not money. One unit of unmet need is the unit;
 * transport is priced per unit-kilometre against it; the expiry term is small
 * enough that it can break a tie but never outrank a need. And the need side is
 * scaled so the most urgent receiver in a request weighs exactly one, because raw
 * priorities differ by orders of magnitude between facilities and an objective
 * nobody can write down is one nobody can argue with. The consequence is stated
 * rather than hidden — **the objective orders plans over one request and is not
 * comparable between requests**, because the scale is the request's own.
 *
 * Determinism is a contract, not an aspiration. Every candidate move is tried in
 * a fixed order derived from identifiers, and a move is applied only when it
 * strictly lowers the objective. The objective is bounded below by zero, so the
 * loop terminates on its own; the pass budget exists so a pathological instance
 * degrades into an answer rather than a hang, and the pass count is reported so a
 * reader can see whether the budget was reached.
 */

// --- The objective, as weights -------------------------------------------------

/** What one unit of unmet need costs. The unit of the scale, by definition. */
export const UNMET_DEMAND_PENALTY_PER_UNIT = 1;

/**
 * What moving one unit one kilometre costs, against a unit of unmet need.
 *
 * `0.002`, which puts a load's whole journey at about half of one unit of need
 * across the five-day travel window: inside the window, serving a facility is
 * almost always worth the drive, and the term is what stops the planner
 * shipping stock to a facility that barely needed it. A stated weight rather
 * than a fare — the platform has no transport contracts to read — and the report
 * prints it beside every impact figure so a reader can disagree with it.
 */
export const TRANSPORT_COST_PER_UNIT_KM = 0.002;

/**
 * What it costs, per unit, to let a batch run down towards expiry unmoved.
 *
 * Small on purpose. Expiry is a reason to move a batch *before* one with more
 * life on it, never a reason to move it somewhere it is not needed: a weight that
 * could outrank an unmet need would ship medicine to a facility with no use for
 * it and call the result an improvement.
 */
export const EXPIRY_LOSS_PER_UNIT = 0.1;

/**
 * How many times the improvement phase may scan the plan before it stops.
 *
 * A bound rather than a convergence argument: a move is applied only when it
 * strictly lowers a non-negative objective, so the loop already terminates. The
 * budget exists so a pathological instance degrades into an answer instead of a
 * hang.
 */
export const MAX_IMPROVEMENT_PASSES = 8;

export interface PlannerOptions {
  readonly maxImprovementPasses?: number | undefined;
  readonly unmetDemandPenaltyPerUnit?: number | undefined;
  readonly transportCostPerUnitKm?: number | undefined;
  readonly expiryLossPerUnit?: number | undefined;
}

// --- Inputs and outputs -------------------------------------------------------

/** What one facility is short of one item. */
export interface TransferNeed {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  /** Units required to reach the facility's target cover. Positive. */
  readonly units: number;
}

export interface PlanRequest {
  /** The day the plan is made for. Shelf life is already measured by the graph. */
  readonly asOf: DateOnly;
  /** The feasibility graph's edges: the moves that are physically possible. */
  readonly edges: readonly TransferEdge[];
  /**
   * Both halves of each ranking, not only the ranked half.
   *
   * A request that carried just the measurable receivers and the usable donors
   * could not report what it had left out, and what a platform leaves out of a
   * plan is exactly what somebody has to act on: a facility the forecast never
   * scored, and a donor whose own floor cannot be computed.
   */
  readonly receivers: ReceiverRanking;
  readonly donors: DonorRanking;
  readonly needs: readonly TransferNeed[];
  readonly options?: PlannerOptions;
}

export interface PlannedTransfer {
  readonly donorId: FacilityId;
  readonly receiverId: FacilityId;
  readonly itemId: ItemId;
  readonly batchId: string;
  readonly quantity: number;
  readonly distanceKm: number;
  readonly leadTimeDays: number;
  readonly shelfLifeOnArrivalDays: number;
  readonly expiresOn: DateOnly;
  readonly coldChain: boolean;
  /** The receiver's position on this request's scale, so a reader can recompute. */
  readonly receiverWeight: number;
}

export interface PlanObjective {
  readonly unmetDemandPenalty: number;
  readonly transportCost: number;
  readonly expiryPenalty: number;
  readonly total: number;
}

export interface UnservedNeed extends TransferNeed {
  readonly receiverWeight: number;
}

export interface PlannerAssumptions {
  readonly maxImprovementPasses: number;
  readonly unmetDemandPenaltyPerUnit: number;
  readonly transportCostPerUnitKm: number;
  readonly expiryLossPerUnit: number;
  /** Receivers whose shortfall probability the forecast never measured. */
  readonly unmeasuredReceivers: ReceiverRanking['unmeasured'];
  /** Donors that may not be drawn on, with the reason they carry. */
  readonly ineligibleDonors: DonorRanking['ineligible'];
}

export interface TransferPlan {
  readonly asOf: DateOnly;
  readonly transfers: readonly PlannedTransfer[];
  readonly objective: PlanObjective;
  /** What the same objective reads with nothing moved, for a report to quote. */
  readonly baseline: PlanObjective;
  /** What is still missing, in rank order. */
  readonly unserved: readonly UnservedNeed[];
  /** How many improvement passes changed something. */
  readonly improvementPasses: number;
  readonly improvementBudgetReached: boolean;
  /** The receiver the weights are relative to, named so the caveat is checkable. */
  readonly weightReference: FacilityId | null;
  readonly assumptions: PlannerAssumptions;
}

// --- Keys and ordering ---------------------------------------------------------

const edgeKeyOf = (edge: TransferEdge): string =>
  `${edge.donorId}|${edge.receiverId}|${edge.itemId}|${edge.batchId}`;

const lotKeyOf = (value: {
  readonly donorId: FacilityId;
  readonly itemId: ItemId;
  readonly batchId: string;
}): string => `${value.donorId}|${value.itemId}|${value.batchId}`;

const donorItemKey = (donorId: FacilityId, itemId: ItemId): string => `${donorId}|${itemId}`;

const needKey = (facilityId: FacilityId, itemId: ItemId): string => `${facilityId}|${itemId}`;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sumBy = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

interface Allocation {
  readonly edgeKey: string;
  readonly quantity: number;
}

interface Working {
  readonly edgeByKey: ReadonlyMap<string, TransferEdge>;
  readonly edgesByNeed: ReadonlyMap<string, readonly TransferEdge[]>;
  readonly lots: ReadonlyMap<string, number>;
  readonly donorSurplus: ReadonlyMap<string, number>;
  readonly weights: ReadonlyMap<string, number>;
  readonly needs: readonly TransferNeed[];
  readonly needUnitsByKey: ReadonlyMap<string, number>;
  readonly expiryDaysByLot: ReadonlyMap<string, number | null>;
  readonly options: {
    readonly unmetDemandPenaltyPerUnit: number;
    readonly transportCostPerUnitKm: number;
    readonly expiryLossPerUnit: number;
  };
}

const quantityOf = (allocations: readonly Allocation[], edgeKey: string): number =>
  allocations.find((allocation) => allocation.edgeKey === edgeKey)?.quantity ?? 0;

const totals = (
  allocations: readonly Allocation[],
  edgeByKey: ReadonlyMap<string, TransferEdge>,
  keyOf: (edge: TransferEdge) => string,
): Map<string, number> => {
  const total = new Map<string, number>();
  for (const allocation of allocations) {
    const edge = edgeByKey.get(allocation.edgeKey);
    if (edge === undefined) {
      continue;
    }
    const key = keyOf(edge);
    total.set(key, (total.get(key) ?? 0) + allocation.quantity);
  }
  return total;
};

const movedByLot = (
  allocations: readonly Allocation[],
  edgeByKey: ReadonlyMap<string, TransferEdge>,
): Map<string, number> => totals(allocations, edgeByKey, lotKeyOf);

const movedByDonorItem = (
  allocations: readonly Allocation[],
  edgeByKey: ReadonlyMap<string, TransferEdge>,
): Map<string, number> =>
  totals(allocations, edgeByKey, (edge) => donorItemKey(edge.donorId, edge.itemId));

const deliveredByNeed = (
  allocations: readonly Allocation[],
  edgeByKey: ReadonlyMap<string, TransferEdge>,
): Map<string, number> =>
  totals(allocations, edgeByKey, (edge) => needKey(edge.receiverId, edge.itemId));

/** A copy of the allocations with one entry's quantity replaced, or added, or dropped. */
function withQuantity(
  allocations: readonly Allocation[],
  edgeKey: string,
  quantity: number,
): Allocation[] {
  if (quantity <= 0) {
    return allocations.filter((allocation) => allocation.edgeKey !== edgeKey);
  }
  return allocations.some((allocation) => allocation.edgeKey === edgeKey)
    ? allocations.map((allocation) =>
        allocation.edgeKey === edgeKey ? { edgeKey, quantity } : allocation,
      )
    : [...allocations, { edgeKey, quantity }];
}

/** The objective, computed from the allocations every time so it cannot drift. */
function objectiveOf(working: Working, allocations: readonly Allocation[]): PlanObjective {
  const delivered = deliveredByNeed(allocations, working.edgeByKey);

  const unmetDemandPenalty = sumBy(
    working.needs.map((need) => {
      const key = needKey(need.facilityId, need.itemId);
      const short = Math.max(0, need.units - (delivered.get(key) ?? 0));
      return short * (working.weights.get(key) ?? 0) * working.options.unmetDemandPenaltyPerUnit;
    }),
  );

  const transportCost = sumBy(
    allocations.map((allocation) => {
      const edge = working.edgeByKey.get(allocation.edgeKey);
      return edge === undefined
        ? 0
        : allocation.quantity * edge.distanceKm * working.options.transportCostPerUnitKm;
    }),
  );

  const moved = movedByLot(allocations, working.edgeByKey);
  const expiryPenalty = sumBy(
    [...working.lots.entries()].map(([key, quantity]) => {
      const left = Math.max(0, quantity - (moved.get(key) ?? 0));
      if (left === 0) {
        return 0;
      }
      const pressure = expiryPressureOf(working.expiryDaysByLot.get(key) ?? null);
      return left * (pressure - 1) * working.options.expiryLossPerUnit;
    }),
  );

  return {
    unmetDemandPenalty,
    transportCost,
    expiryPenalty,
    total: unmetDemandPenalty + transportCost + expiryPenalty,
  };
}

const inPlanOrder =
  (edgeByKey: ReadonlyMap<string, TransferEdge>) =>
  (left: Allocation, right: Allocation): number => {
    const a = edgeByKey.get(left.edgeKey);
    const b = edgeByKey.get(right.edgeKey);
    if (a === undefined || b === undefined) {
      return compareText(left.edgeKey, right.edgeKey);
    }
    return (
      compareText(a.donorId, b.donorId) ||
      compareText(a.receiverId, b.receiverId) ||
      compareText(a.itemId, b.itemId) ||
      compareText(a.batchId, b.batchId)
    );
  };

/** Cheapest first, then by name — never by the order the caller happened to pass. */
const cheapestFirst = (left: TransferEdge, right: TransferEdge): number =>
  left.distanceKm - right.distanceKm ||
  compareText(left.batchId, right.batchId) ||
  compareText(left.donorId, right.donorId) ||
  compareText(left.receiverId, right.receiverId);

// --- The planner ---------------------------------------------------------------

export function planTransfers(request: PlanRequest): TransferPlan {
  const options = {
    unmetDemandPenaltyPerUnit:
      request.options?.unmetDemandPenaltyPerUnit ?? UNMET_DEMAND_PENALTY_PER_UNIT,
    transportCostPerUnitKm: request.options?.transportCostPerUnitKm ?? TRANSPORT_COST_PER_UNIT_KM,
    expiryLossPerUnit: request.options?.expiryLossPerUnit ?? EXPIRY_LOSS_PER_UNIT,
  };
  const maxPasses = request.options?.maxImprovementPasses ?? MAX_IMPROVEMENT_PASSES;

  const edgeByKey = new Map(request.edges.map((edge) => [edgeKeyOf(edge), edge]));

  // The need scale, set by the most urgent receiver in this request. A receiver
  // whose shortfall probability was never measured gets no weight at all rather
  // than a small one: it is not a facility with a small problem, it is a facility
  // the platform cannot currently plan for, and it is reported as such.
  let weightReference: FacilityId | null = null;
  let mostUrgent = 0;
  for (const receiver of request.receivers.ranked) {
    if (receiver.priority > mostUrgent) {
      mostUrgent = receiver.priority;
      weightReference = receiver.facilityId;
    }
  }
  const weights = new Map<string, number>();
  if (mostUrgent > 0) {
    for (const receiver of request.receivers.ranked) {
      weights.set(needKey(receiver.facilityId, receiver.itemId), receiver.priority / mostUrgent);
    }
  }

  const lots = new Map<string, number>();
  for (const edge of request.edges) {
    const key = lotKeyOf(edge);
    lots.set(key, Math.max(lots.get(key) ?? 0, edge.quantity));
  }

  const expiryDaysByLot = new Map<string, number | null>();
  for (const edge of request.edges) {
    expiryDaysByLot.set(lotKeyOf(edge), daysBetween(request.asOf, edge.expiresOn));
  }

  const donorSurplus = new Map<string, number>();
  for (const donor of request.donors.ranked) {
    if (donor.surplus > 0) {
      donorSurplus.set(donorItemKey(donor.facilityId, donor.itemId), donor.surplus);
    }
  }

  // Only needs the platform can measure are planned for; the rest are reported.
  const needs = request.needs.filter((need) => weights.has(needKey(need.facilityId, need.itemId)));
  const needUnitsByKey = new Map(
    needs.map((need) => [needKey(need.facilityId, need.itemId), need.units]),
  );

  const edgesByNeed = new Map<string, TransferEdge[]>();
  for (const edge of request.edges) {
    const key = needKey(edge.receiverId, edge.itemId);
    if (!weights.has(key)) {
      continue;
    }
    const list = edgesByNeed.get(key) ?? [];
    list.push(edge);
    edgesByNeed.set(key, list);
  }
  for (const list of edgesByNeed.values()) {
    list.sort(cheapestFirst);
  }

  const rankOf = new Map<string, number>();
  for (const receiver of request.receivers.ranked) {
    rankOf.set(needKey(receiver.facilityId, receiver.itemId), receiver.rank);
  }
  const orderedNeeds = [...needs].sort(
    (left, right) =>
      (rankOf.get(needKey(left.facilityId, left.itemId)) ?? Number.MAX_SAFE_INTEGER) -
        (rankOf.get(needKey(right.facilityId, right.itemId)) ?? Number.MAX_SAFE_INTEGER) ||
      compareText(left.facilityId, right.facilityId) ||
      compareText(left.itemId, right.itemId),
  );

  const working: Working = {
    edgeByKey,
    edgesByNeed,
    lots,
    donorSurplus,
    weights,
    needs,
    needUnitsByKey,
    expiryDaysByLot,
    options,
  };

  /**
   * Room for more along one edge, from every limit that applies: the batch, the
   * donor's surplus above its own floor, and the receiver's remaining need. One
   * function, so the planner cannot respect a limit in one place and forget it in
   * another — the donor floor is enforced here and therefore everywhere.
   */
  const roomFor = (
    allocations: readonly Allocation[],
    edge: TransferEdge,
    needUnits: number,
  ): number => {
    const lotRoom =
      (lots.get(lotKeyOf(edge)) ?? 0) -
      (movedByLot(allocations, edgeByKey).get(lotKeyOf(edge)) ?? 0);
    const surplusRoom =
      (donorSurplus.get(donorItemKey(edge.donorId, edge.itemId)) ?? 0) -
      (movedByDonorItem(allocations, edgeByKey).get(donorItemKey(edge.donorId, edge.itemId)) ?? 0);
    const needRoom =
      needUnits -
      (deliveredByNeed(allocations, edgeByKey).get(needKey(edge.receiverId, edge.itemId)) ?? 0);
    return Math.max(0, Math.min(lotRoom, surplusRoom, needRoom));
  };

  /** Give one receiver up to `units`, over its cheapest edges, stopping when it is answered. */
  const fill = (
    allocations: readonly Allocation[],
    receiverId: FacilityId,
    itemId: ItemId,
    units: number,
  ): Allocation[] => {
    let next = [...allocations];
    let remaining = units;
    for (const edge of edgesByNeed.get(needKey(receiverId, itemId)) ?? []) {
      if (remaining <= 0) {
        break;
      }
      const room = roomFor(next, edge, units);
      if (room <= 0) {
        continue;
      }
      const give = Math.min(room, remaining);
      next = withQuantity(next, edgeKeyOf(edge), quantityOf(next, edgeKeyOf(edge)) + give);
      remaining -= give;
    }
    return next;
  };

  // --- Construction: receivers in rank order, cheapest supply first -----------
  // A move is kept only when it lowers the objective, so a plan can never grow
  // more expensive than the need it answers — the filter the phase's failure note
  // asks for, applied by the objective rather than by a thumb on the scale.
  let allocations: Allocation[] = [];
  for (const need of orderedNeeds) {
    const filled = fill(allocations, need.facilityId, need.itemId, need.units);
    if (objectiveOf(working, filled).total < objectiveOf(working, allocations).total) {
      allocations = filled;
    }
  }

  // --- Improvement: bounded passes, one strictly-improving move at a time -----
  let improvementPasses = 0;
  let improved = true;
  while (improved && improvementPasses < maxPasses) {
    improved = false;
    improvementPasses += 1;

    // 1. Drop anything that costs more than it answers.
    for (const allocation of [...allocations].sort(inPlanOrder(edgeByKey))) {
      const trial = allocations.filter((candidate) => candidate.edgeKey !== allocation.edgeKey);
      if (objectiveOf(working, trial).total < objectiveOf(working, allocations).total) {
        allocations = trial;
        improved = true;
      }
    }

    // 2. Grow anything with room, when the growth pays for itself.
    for (const allocation of [...allocations].sort(inPlanOrder(edgeByKey))) {
      const edge = edgeByKey.get(allocation.edgeKey);
      if (edge === undefined) {
        continue;
      }
      const needUnits = needUnitsByKey.get(needKey(edge.receiverId, edge.itemId)) ?? 0;
      const room = roomFor(allocations, edge, needUnits);
      if (room <= 0) {
        continue;
      }
      const trial = withQuantity(allocations, allocation.edgeKey, allocation.quantity + room);
      if (objectiveOf(working, trial).total < objectiveOf(working, allocations).total) {
        allocations = trial;
        improved = true;
      }
    }

    // 3. Release a scarce batch for a receiver that has no other supplier.
    //
    // The move greedy cannot make. A batch is consumed by a delivery to one
    // facility; when another facility can *only* be served from that batch, and
    // the holder can be served from somewhere else, moving the delivery releases
    // it. The whole re-sourced plan is scored, not just the re-sourcing: on its
    // own the second-best supplier is dearer, and it is only an improvement once
    // the need it releases is counted.
    for (const need of orderedNeeds) {
      const needUnits = need.units;
      // Only a receiver that is still short is worth re-sourcing for, and only
      // when its cheapest supply is exhausted.
      const cheapest = (edgesByNeed.get(needKey(need.facilityId, need.itemId)) ?? [])[0];
      if (cheapest === undefined || roomFor(allocations, cheapest, needUnits) > 0) {
        continue;
      }

      let applied = false;
      for (const scarce of edgesByNeed.get(needKey(need.facilityId, need.itemId)) ?? []) {
        if (applied) {
          break;
        }
        const holders = allocations
          .filter((allocation) => {
            const edge = edgeByKey.get(allocation.edgeKey);
            return edge !== undefined && lotKeyOf(edge) === lotKeyOf(scarce);
          })
          .sort(inPlanOrder(edgeByKey));

        for (const holder of holders) {
          const held = edgeByKey.get(holder.edgeKey);
          if (held === undefined) {
            continue;
          }
          const holderNeedUnits =
            needUnitsByKey.get(needKey(held.receiverId, held.itemId)) ?? held.quantity;
          const without = allocations.filter((candidate) => candidate.edgeKey !== holder.edgeKey);

          for (const alternative of edgesByNeed.get(needKey(held.receiverId, held.itemId)) ?? []) {
            if (lotKeyOf(alternative) === lotKeyOf(scarce)) {
              continue;
            }
            if (roomFor(without, alternative, holderNeedUnits) < holder.quantity) {
              continue;
            }

            let trial = withQuantity(
              without,
              edgeKeyOf(alternative),
              quantityOf(without, edgeKeyOf(alternative)) + holder.quantity,
            );
            const released = roomFor(trial, scarce, needUnits);
            if (released <= 0) {
              continue;
            }
            trial = withQuantity(
              trial,
              edgeKeyOf(scarce),
              quantityOf(trial, edgeKeyOf(scarce)) + released,
            );

            if (objectiveOf(working, trial).total < objectiveOf(working, allocations).total) {
              allocations = trial;
              improved = true;
              applied = true;
              break;
            }
          }
          if (applied) {
            break;
          }
        }
      }
    }

    // 4. Spend whatever is free on the highest-ranked need still short.
    for (const need of orderedNeeds) {
      const filled = fill(allocations, need.facilityId, need.itemId, need.units);
      if (objectiveOf(working, filled).total < objectiveOf(working, allocations).total) {
        allocations = filled;
        improved = true;
      }
    }
  }

  const ordered = [...allocations].sort(inPlanOrder(edgeByKey));
  const transfers: PlannedTransfer[] = ordered.flatMap((allocation) => {
    const edge = edgeByKey.get(allocation.edgeKey);
    return edge === undefined
      ? []
      : [
          {
            donorId: edge.donorId,
            receiverId: edge.receiverId,
            itemId: edge.itemId,
            batchId: edge.batchId,
            quantity: allocation.quantity,
            distanceKm: edge.distanceKm,
            leadTimeDays: edge.leadTimeDays,
            shelfLifeOnArrivalDays: edge.shelfLifeOnArrivalDays,
            expiresOn: edge.expiresOn,
            coldChain: edge.coldChain,
            receiverWeight: weights.get(needKey(edge.receiverId, edge.itemId)) ?? 0,
          },
        ];
  });

  const delivered = deliveredByNeed(allocations, edgeByKey);
  const unserved: UnservedNeed[] = orderedNeeds.flatMap((need) => {
    const key = needKey(need.facilityId, need.itemId);
    const short = need.units - (delivered.get(key) ?? 0);
    return short <= 0 ? [] : [{ ...need, units: short, receiverWeight: weights.get(key) ?? 0 }];
  });

  return {
    asOf: request.asOf,
    transfers,
    objective: objectiveOf(working, allocations),
    baseline: objectiveOf(working, []),
    unserved,
    improvementPasses,
    improvementBudgetReached: improvementPasses >= maxPasses,
    weightReference,
    assumptions: {
      maxImprovementPasses: maxPasses,
      unmetDemandPenaltyPerUnit: options.unmetDemandPenaltyPerUnit,
      transportCostPerUnitKm: options.transportCostPerUnitKm,
      expiryLossPerUnit: options.expiryLossPerUnit,
      unmeasuredReceivers: request.receivers.unmeasured,
      ineligibleDonors: request.donors.ineligible,
    },
  };
}
