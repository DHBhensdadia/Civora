import { mean } from './series';
import type { DemandSeries } from './types';

/**
 * What comparable facilities suggest, for a series that cannot speak for itself.
 *
 * A newly opened facility has no history, and the honest options are to forecast
 * nothing or to borrow from facilities that do have one. Borrowing is the better
 * answer as long as it is disclosed: the forecast says `pooled-prior`, names how
 * many series it was pooled from, and states the rate it applied.
 *
 * The pool is deliberately narrow — the same item at facilities of the same tier
 * in the same district — because that is the comparison an officer would accept.
 * A national average would be a number about the country rather than about this
 * facility, and the difference between a sub-centre and a community health centre
 * is a factor of thirty in catchment.
 */

export interface PooledPriorOptions {
  /** Days to consider, taken from the end of each series. Defaults to 56. */
  readonly windowDays?: number;
}

export interface PooledPrior {
  /** Mean daily demand across the pool, weighted by the days observed. */
  readonly dailyDemand: number;
  /** Share of pooled days on which something moved. */
  readonly occurrenceRate: number;
  /** Series that contributed at least one day. */
  readonly seriesUsed: number;
  /** Total days pooled. */
  readonly daysObserved: number;
}

const DEFAULT_WINDOW_DAYS = 56;

export function pooledPrior(
  series: readonly DemandSeries[],
  options: PooledPriorOptions = {},
): PooledPrior {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const windowed = series
    .map((entry) => entry.points.slice(Math.max(0, entry.points.length - windowDays)))
    .filter((points) => points.length > 0);

  if (windowed.length === 0) {
    return { dailyDemand: 0, occurrenceRate: 0, seriesUsed: 0, daysObserved: 0 };
  }

  const perSeriesRates = windowed.map((points) => mean(points.map((point) => point.issued)));
  const daysObserved = windowed.reduce((total, points) => total + points.length, 0);
  const movingDays = windowed.reduce(
    (total, points) => total + points.filter((point) => point.issued > 0).length,
    0,
  );

  return {
    // Unweighted across series: a facility with four months of history should not
    // outvote four facilities with one month each when the question is what a
    // typical comparable facility consumes.
    dailyDemand: mean(perSeriesRates),
    occurrenceRate: movingDays / daysObserved,
    seriesUsed: windowed.length,
    daysObserved,
  };
}
