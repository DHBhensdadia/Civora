import type { ItemId } from '@civora/domain';
import type { DemandSeries } from '@civora/forecasting';

/**
 * The communication-efficient fast path, which is also the useful one.
 *
 * Parameter averaging is the demonstration; *statistic* sharing is the product.
 * A silo that has never stocked an item cannot forecast it from its own past,
 * and the honest options are to forecast nothing or to borrow from comparable
 * facilities. Borrowing needs only sums and counts — days observed, units
 * issued, months those fell in — which is a vastly smaller payload than a
 * parameter vector and carries no record either.
 *
 * The figures are then handed to the forecaster through the options it already
 * has (`priorDailyDemand`, `priorSeriesUsed`), so the cold-start path that ships
 * is the one Phase 4 built, fed by a producer that did not exist before.
 */

export interface MonthlyCount {
  readonly month: number;
  readonly daysObserved: number;
  readonly unitsIssued: number;
}

/** What one silo knows about one item, in numbers that are safe to share. */
export interface SiloItemStatistics {
  readonly siloId: string;
  readonly itemId: ItemId;
  readonly daysObserved: number;
  readonly unitsIssued: number;
  readonly movingDays: number;
  readonly monthly: readonly MonthlyCount[];
}

export interface SiloStatisticsInput {
  readonly siloId: string;
  readonly series: readonly DemandSeries[];
}

export interface StatisticOptions {
  /** Days of each series to read, taken from the end. Default 56, as Phase 4. */
  readonly windowDays?: number;
}

export const DEFAULT_STATISTIC_WINDOW_DAYS = 56;

/** Sums and counts per item, from a silo's own series. */
export function statisticsForSilo(
  input: SiloStatisticsInput,
  options: StatisticOptions = {},
): readonly SiloItemStatistics[] {
  const windowDays = options.windowDays ?? DEFAULT_STATISTIC_WINDOW_DAYS;
  const byItem = new Map<
    string,
    {
      itemId: ItemId;
      days: number;
      units: number;
      moving: number;
      monthly: Map<number, MonthlyCount>;
    }
  >();

  for (const entry of input.series) {
    const points = entry.points.slice(Math.max(0, entry.points.length - windowDays));
    if (points.length === 0) {
      continue;
    }
    const held = byItem.get(entry.itemId) ?? {
      itemId: entry.itemId,
      days: 0,
      units: 0,
      moving: 0,
      monthly: new Map<number, MonthlyCount>(),
    };
    for (const point of points) {
      held.days += 1;
      held.units += point.issued;
      if (point.issued > 0) {
        held.moving += 1;
      }
      const month = Number(point.on.slice(5, 7));
      const bucket = held.monthly.get(month) ?? { month, daysObserved: 0, unitsIssued: 0 };
      held.monthly.set(month, {
        month,
        daysObserved: bucket.daysObserved + 1,
        unitsIssued: bucket.unitsIssued + point.issued,
      });
    }
    byItem.set(entry.itemId, held);
  }

  return [...byItem.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([_key, held]) => ({
      siloId: input.siloId,
      itemId: held.itemId,
      daysObserved: held.days,
      unitsIssued: held.units,
      movingDays: held.moving,
      monthly: [...held.monthly.values()].sort((left, right) => left.month - right.month),
    }));
}

export interface FederatedItemPrior {
  readonly itemId: ItemId;
  /** Mean daily demand pooled across the silos that shared a statistic. */
  readonly dailyDemand: number;
  readonly occurrenceRate: number;
  /** Silos contributing, and the days they contributed. */
  readonly silos: number;
  readonly seriesUsed: number;
  readonly daysObserved: number;
  /** Share of the item's annual rate each month carried, where there is evidence. */
  readonly seasonalFactors: readonly {
    readonly month: number;
    readonly factor: number;
    readonly daysObserved: number;
  }[];
}

/** Pool one item's statistics across silos, weighted by the days behind them. */
export function federatedPriorFor(
  itemId: ItemId,
  statistics: readonly SiloItemStatistics[],
): FederatedItemPrior | null {
  const relevant = statistics.filter((entry) => entry.itemId === itemId && entry.daysObserved > 0);
  if (relevant.length === 0) {
    return null;
  }

  const daysObserved = relevant.reduce((total, entry) => total + entry.daysObserved, 0);
  const unitsIssued = relevant.reduce((total, entry) => total + entry.unitsIssued, 0);
  const movingDays = relevant.reduce((total, entry) => total + entry.movingDays, 0);
  const annualDaily = daysObserved === 0 ? 0 : unitsIssued / daysObserved;

  const months = new Map<number, { days: number; units: number }>();
  for (const entry of relevant) {
    for (const month of entry.monthly) {
      const held = months.get(month.month) ?? { days: 0, units: 0 };
      months.set(month.month, {
        days: held.days + month.daysObserved,
        units: held.units + month.unitsIssued,
      });
    }
  }

  const seasonalFactors = [...months.entries()]
    .sort(([left], [right]) => left - right)
    .map(([month, held]) => ({
      month,
      factor: annualDaily === 0 || held.days === 0 ? 0 : held.units / held.days / annualDaily,
      daysObserved: held.days,
    }));

  return {
    itemId,
    dailyDemand: annualDaily,
    occurrenceRate: daysObserved === 0 ? 0 : movingDays / daysObserved,
    silos: new Set(relevant.map((entry) => entry.siloId)).size,
    seriesUsed: relevant.length,
    daysObserved,
    seasonalFactors,
  };
}

/** The fields the forecaster's cold-start options expect, named as it names them. */
export const forecasterPriorFields = (
  prior: FederatedItemPrior,
): {
  readonly priorDailyDemand: number;
  readonly priorSeriesUsed: number;
} => ({ priorDailyDemand: prior.dailyDemand, priorSeriesUsed: prior.seriesUsed });
