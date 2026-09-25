import { replayStockLedger } from '@civora/domain';
import type { DateOnly, FacilityId, ItemId, StockLedgerEntry } from '@civora/domain';

import type { DemandPoint, DemandSeries, ForecastFeature } from './types';

/**
 * Series arithmetic, and the statistics that decide how a series is treated.
 *
 * Every function here is total: an empty list has an answer rather than an
 * exception, because the caller that matters — a facility with no history — is
 * exactly the case the platform has to handle without failing.
 */

export const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

export const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : sum(values) / values.length;

/** Sample standard deviation; zero for fewer than two observations. */
export const stdev = (values: readonly number[]): number => {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  const variance = sum(values.map((value) => (value - average) ** 2)) / (values.length - 1);
  return Math.sqrt(variance);
};

/**
 * The empirical quantile of a sample, by linear interpolation between the two
 * observations that bracket the position.
 *
 * Deliberately not a normal approximation. Intermittent medicine demand is
 * zero on most days and spiky on the rest, and a Gaussian quantile of such a
 * sample is a number with no basis in the data.
 */
export const quantile = (values: readonly number[], level: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, level));
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
};

/** How often a series moves, and how unevenly, per the Syntetos–Boylan measures. */
export interface SeriesStatistics {
  /** Days observed. */
  readonly days: number;
  /** Days on which something was dispensed. */
  readonly movingDays: number;
  /** Mean units per day across every day, including the silent ones. */
  readonly meanDaily: number;
  /** Mean units per day on the days that moved. */
  readonly meanWhenMoving: number;
  /** Share of days that moved. */
  readonly occurrenceRate: number;
  /** Average demand interval: days per movement. */
  readonly averageDemandInterval: number;
  /** Squared coefficient of variation of the non-zero demand sizes. */
  readonly demandVariabilitySquared: number;
}

export const seriesStatistics = (points: readonly DemandPoint[]): SeriesStatistics => {
  const issued = points.map((point) => point.issued);
  const moving = issued.filter((value) => value > 0);
  const meanWhenMoving = mean(moving);

  return {
    days: points.length,
    movingDays: moving.length,
    meanDaily: mean(issued),
    meanWhenMoving,
    occurrenceRate: points.length === 0 ? 0 : moving.length / points.length,
    averageDemandInterval:
      moving.length === 0 ? Number.POSITIVE_INFINITY : points.length / moving.length,
    demandVariabilitySquared: meanWhenMoving === 0 ? 0 : (stdev(moving) / meanWhenMoving) ** 2,
  };
};

/**
 * The `LedgerDay` series for one facility and item, over a window.
 *
 * Taken from the ledger by replay rather than from the observations directly,
 * so a forecast is made on the same numbers the platform shows an officer.
 * Anything else would let the two disagree, and the one nobody looks at would be
 * the wrong one.
 */
export function buildDemandSeries(
  entries: readonly StockLedgerEntry[],
  facilityId: FacilityId,
  itemId: ItemId,
  window: { readonly from: DateOnly; readonly to: DateOnly },
): DemandSeries {
  const replay = replayStockLedger(entries, facilityId, itemId, window);

  return {
    facilityId,
    itemId,
    points: replay.days.map((day) => ({ on: day.on, issued: day.issued, onHand: day.onHand })),
  };
}

/** Named numbers describing a series, for the forecast's own record. */
export const seriesFeatures = (points: readonly DemandPoint[]): readonly ForecastFeature[] => {
  const statistics = seriesStatistics(points);
  return [
    { name: 'days', value: statistics.days },
    { name: 'movingDays', value: statistics.movingDays },
    { name: 'meanDaily', value: statistics.meanDaily },
    { name: 'meanWhenMoving', value: statistics.meanWhenMoving },
    { name: 'occurrenceRate', value: statistics.occurrenceRate },
    {
      name: 'averageDemandInterval',
      value: Number.isFinite(statistics.averageDemandInterval)
        ? statistics.averageDemandInterval
        : 0,
    },
    { name: 'demandVariabilitySquared', value: statistics.demandVariabilitySquared },
  ];
};
