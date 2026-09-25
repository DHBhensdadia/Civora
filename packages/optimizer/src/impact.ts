import type { FacilityId, ItemId } from '@civora/domain';

import type { PlannedTransfer } from './planner';
import { TRANSPORT_COST_PER_UNIT_KM } from './planner';

/**
 * What a transfer is expected to prevent, and what it costs — with the way the
 * number was reached printed beside it.
 *
 * This module exists to answer the only question an officer actually has when
 * stock is offered: *what does moving this buy me?* It answers it from the
 * forecast the platform already stores, and it refuses to answer it from
 * anything it cannot derive. Two disciplines decide the whole design:
 *
 *  - **The estimate is a projection over the forecast's own quantiles, not a
 *    formula applied to its mean.** A median demand path and an upper-quantile
 *    path are each run through the receiver's stock day by day; the day demand
 *    outruns cover is a stock-out day, and the units that went unmet are unmet
 *    demand. The two paths are then weighted by the receiver's *measured*
 *    shortfall probability — the one number Phase 4 already reports for exactly
 *    this question — so the expected figure is a mixture of two stated
 *    scenarios rather than a single path dressed up as a certainty. When that
 *    probability was never measured the module says so and reports the median
 *    path alone, labelled, instead of inventing a weight.
 *  - **A transfer that cannot be quantified is not a transfer worth zero.** A
 *    receiver with no forecast produces no estimate at all; it is listed as
 *    unquantified, with the reason, rather than folded into a total that would
 *    then read as a measured result.
 *
 * The cost side is deliberately the *same* weight the planner minimises
 * against, so the report and the objective cannot price a kilometre
 * differently, and the verdict beside a transfer is a plain comparison of what
 * it is expected to avoid against what it costs to run. The module is written
 * to be able to return a **negative or marginal case**: a load that lands after
 * the shelf has emptied avoids nothing and its transport is pure cost. An
 * estimator that only ever finds a win is not an estimator.
 */

/** The projection, named so a report can print which one produced a figure. */
export const IMPACT_METHOD = 'two-quantile-stock-projection';

/** What a unit of avoided unmet demand is worth against a unit-kilometre. */
export const DEFAULT_COST_PER_UNIT_KM = TRANSPORT_COST_PER_UNIT_KM;

/**
 * One receiver's forecast, as the two daily quantile paths the platform stores.
 *
 * The arrays are the forecast's `p50` and `p90` verbatim, one entry per day from
 * `asOf` + 1. `onHandUnits` is what the receiver holds today, and the projection
 * consumes it against each day's demand, so a receiver already in stock-out is
 * modelled as one rather than at parity.
 */
export interface ReceiverDemand {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly onHandUnits: number;
  readonly p50: readonly number[];
  readonly p90: readonly number[];
  /**
   * Phase 4's measured probability that demand outruns stock before a delivery
   * can arrive. `null` when the forecast could not measure it, which changes how
   * the two paths are combined and is reported.
   */
  readonly shortfallProbability: number | null;
}

export interface ImpactOptions {
  readonly costPerUnitKm?: number | undefined;
}

/** One transfer, projected. Every field is either measured or derived here. */
export interface TransferImpact {
  readonly donorId: FacilityId;
  readonly receiverId: FacilityId;
  readonly itemId: ItemId;
  readonly batchId: string;
  readonly units: number;
  readonly distanceKm: number;
  readonly leadTimeDays: number;
  /** Units of demand the projection says would otherwise go unmet. */
  readonly expectedUnmetDemandAvoided: number;
  /** Days on which demand would otherwise outrun cover. */
  readonly expectedStockOutDaysAverted: number;
  readonly baselineUnmetDemand: number;
  readonly withTransferUnmetDemand: number;
  /** Every unit-kilometre priced at the planner's own weight. */
  readonly transportCost: number;
  /** `expectedUnmetDemandAvoided − transportCost`. Negative is a real outcome. */
  readonly netBenefit: number;
  readonly assessment: 'beneficial' | 'marginal' | 'negative';
  /** One sentence naming what decided the verdict. */
  readonly note: string;
}

/** A transfer the module declines to price, with the reason it declined. */
export interface UnquantifiedTransfer {
  readonly receiverId: FacilityId;
  readonly itemId: ItemId;
  readonly reason: string;
}

export interface ImpactAssumptions {
  readonly method: string;
  /** The paths combined, and over what horizon. */
  readonly scenarios: readonly string[];
  readonly horizonDays: number;
  readonly costPerUnitKm: number;
  /** Whether a measured shortfall probability weighted the two paths. */
  readonly weightedByShortfallProbability: boolean;
}

export interface PlanImpact {
  readonly transfers: readonly TransferImpact[];
  readonly unquantified: readonly UnquantifiedTransfer[];
  readonly totalExpectedUnmetDemandAvoided: number;
  readonly totalExpectedStockOutDaysAverted: number;
  readonly totalTransportCost: number;
  readonly totalNetBenefit: number;
  /** Transfers whose net benefit is zero or below, for the report to quote. */
  readonly marginalOrNegative: readonly TransferImpact[];
  readonly assumptions: ImpactAssumptions;
}

const key = (facilityId: FacilityId, itemId: ItemId): string => `${facilityId}|${itemId}`;

const round2 = (value: number): number => Math.round(value * 100) / 100;

interface Projection {
  readonly unmet: number;
  readonly stockOutDays: number;
}

/**
 * Run one demand path against the receiver's stock, adding the load on the day
 * it lands.
 *
 * The whole point of the projection is the interaction between the two: a load
 * that arrives after the shelf has emptied does not rescue the days before it,
 * and a load larger than the remaining demand is not worth its journey. Neither
 * fact survives being estimated as a difference of two averages, which is why
 * the loop exists rather than a closed form.
 */
function project(input: {
  readonly path: readonly number[];
  readonly onHandUnits: number;
  readonly arrivalDay: number;
  readonly addedUnits: number;
}): Projection {
  let stock = input.onHandUnits;
  let unmet = 0;
  let stockOutDays = 0;

  for (let day = 0; day < input.path.length; day += 1) {
    if (day === input.arrivalDay) {
      stock += input.addedUnits;
    }
    const demand = input.path[day] ?? 0;
    const issued = Math.min(stock, demand);
    if (demand > issued) {
      stockOutDays += 1;
    }
    unmet += demand - issued;
    stock -= issued;
  }

  return { unmet, stockOutDays };
}

/**
 * Price one transfer against one receiver's forecast.
 *
 * `null` when the receiver's forecast horizon is empty — there is nothing to
 * project over, which is reported as unquantified rather than as zero.
 */
function impactOf(
  transfer: PlannedTransfer,
  demand: ReceiverDemand,
  costPerUnitKm: number,
): TransferImpact | null {
  const horizonDays = Math.min(demand.p50.length, demand.p90.length);
  if (horizonDays === 0) {
    return null;
  }

  const p50Path = demand.p50.slice(0, horizonDays);
  const p90Path = demand.p90.slice(0, horizonDays);
  const arrivalDay = transfer.leadTimeDays;

  const medianBaseline = project({
    path: p50Path,
    onHandUnits: demand.onHandUnits,
    arrivalDay,
    addedUnits: 0,
  });
  const medianWith = project({
    path: p50Path,
    onHandUnits: demand.onHandUnits,
    arrivalDay,
    addedUnits: transfer.quantity,
  });
  const upperBaseline = project({
    path: p90Path,
    onHandUnits: demand.onHandUnits,
    arrivalDay,
    addedUnits: 0,
  });
  const upperWith = project({
    path: p90Path,
    onHandUnits: demand.onHandUnits,
    arrivalDay,
    addedUnits: transfer.quantity,
  });

  // The weight on the upper path is the receiver's own measured probability that
  // demand outruns cover. With no measured probability the median path stands
  // alone and the assumption list says the two were not combined.
  const upperWeight = demand.shortfallProbability ?? 0;
  const lowerWeight = 1 - upperWeight;

  const baselineUnmetDemand =
    lowerWeight * medianBaseline.unmet + upperWeight * upperBaseline.unmet;
  const withTransferUnmetDemand = lowerWeight * medianWith.unmet + upperWeight * upperWith.unmet;
  const expectedUnmetDemandAvoided = baselineUnmetDemand - withTransferUnmetDemand;
  const expectedStockOutDaysAverted =
    lowerWeight * (medianBaseline.stockOutDays - medianWith.stockOutDays) +
    upperWeight * (upperBaseline.stockOutDays - upperWith.stockOutDays);

  const transportCost = transfer.quantity * transfer.distanceKm * costPerUnitKm;
  const netBenefit = expectedUnmetDemandAvoided - transportCost;

  const assessment: TransferImpact['assessment'] =
    expectedUnmetDemandAvoided <= 0 ? 'negative' : netBenefit <= 0 ? 'marginal' : 'beneficial';

  const note =
    assessment === 'negative'
      ? `the load lands on day ${String(arrivalDay)} and avoids no unmet demand over the ${String(horizonDays)}-day horizon, so its ${transportCost.toFixed(1)} unit-kilometres buy nothing`
      : assessment === 'marginal'
        ? `avoids ${expectedUnmetDemandAvoided.toFixed(1)} units of unmet demand against ${transportCost.toFixed(1)} units of transport cost`
        : `avoids ${expectedUnmetDemandAvoided.toFixed(1)} units of unmet demand over ${String(horizonDays)} days at a transport cost of ${transportCost.toFixed(1)}`;

  return {
    donorId: transfer.donorId,
    receiverId: transfer.receiverId,
    itemId: transfer.itemId,
    batchId: transfer.batchId,
    units: transfer.quantity,
    distanceKm: transfer.distanceKm,
    leadTimeDays: transfer.leadTimeDays,
    expectedUnmetDemandAvoided: round2(expectedUnmetDemandAvoided),
    expectedStockOutDaysAverted: round2(expectedStockOutDaysAverted),
    baselineUnmetDemand: round2(baselineUnmetDemand),
    withTransferUnmetDemand: round2(withTransferUnmetDemand),
    transportCost: round2(transportCost),
    netBenefit: round2(netBenefit),
    assessment,
    note,
  };
}

/**
 * Estimate the impact of a whole plan.
 *
 * A transfer whose receiver has no forecast is reported as unquantified and is
 * excluded from every total, so a total never contains a zero standing in for a
 * quantity nobody measured. A plan that moves nothing has an impact of nothing —
 * which is the honest answer, and the negative control the phase asks for.
 */
export function estimateImpact(input: {
  readonly plan: readonly PlannedTransfer[];
  readonly demands: readonly ReceiverDemand[];
  readonly options?: ImpactOptions | undefined;
}): PlanImpact {
  const costPerUnitKm = input.options?.costPerUnitKm ?? DEFAULT_COST_PER_UNIT_KM;
  const demands = new Map(
    input.demands.map((demand) => [key(demand.facilityId, demand.itemId), demand]),
  );

  const transfers: TransferImpact[] = [];
  const unquantified: UnquantifiedTransfer[] = [];
  const horizons: number[] = [];
  let weighted = false;

  for (const transfer of input.plan) {
    const demand = demands.get(key(transfer.receiverId, transfer.itemId));
    if (demand === undefined) {
      unquantified.push({
        receiverId: transfer.receiverId,
        itemId: transfer.itemId,
        reason: `no forecast is stored for ${transfer.receiverId} and ${transfer.itemId}, so this transfer has no impact to estimate`,
      });
      continue;
    }
    const priced = impactOf(transfer, demand, costPerUnitKm);
    if (priced === null) {
      unquantified.push({
        receiverId: transfer.receiverId,
        itemId: transfer.itemId,
        reason: `the forecast for ${transfer.receiverId} and ${transfer.itemId} covers no days, so nothing can be projected`,
      });
      continue;
    }
    if (demand.shortfallProbability !== null) {
      weighted = true;
    }
    horizons.push(Math.min(demand.p50.length, demand.p90.length));
    transfers.push(priced);
  }

  const sum = (values: readonly number[]): number =>
    values.reduce((total, value) => total + value, 0);
  // The shortest horizon any priced transfer was projected over, so the printed
  // assumption is never longer than the evidence behind a figure.
  const horizonDays = horizons.length === 0 ? 0 : Math.min(...horizons);

  return {
    transfers,
    unquantified,
    totalExpectedUnmetDemandAvoided: round2(
      sum(transfers.map((each) => each.expectedUnmetDemandAvoided)),
    ),
    totalExpectedStockOutDaysAverted: round2(
      sum(transfers.map((each) => each.expectedStockOutDaysAverted)),
    ),
    totalTransportCost: round2(sum(transfers.map((each) => each.transportCost))),
    totalNetBenefit: round2(sum(transfers.map((each) => each.netBenefit))),
    marginalOrNegative: transfers.filter((each) => each.assessment !== 'beneficial'),
    assumptions: {
      method: IMPACT_METHOD,
      scenarios: [
        'median daily demand path (p50), weight 1 − shortfall probability',
        'upper-quantile daily demand path (p90), weight the measured shortfall probability',
      ],
      horizonDays,
      costPerUnitKm,
      weightedByShortfallProbability: weighted,
    },
  };
}
