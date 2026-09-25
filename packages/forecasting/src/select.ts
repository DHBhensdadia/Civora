import type { ForecastMethod } from '@civora/domain';

import { seriesStatistics } from './series';
import type { DemandPoint } from './types';
import type { SeriesStatistics } from './series';

/**
 * Choosing a method from the shape of the data.
 *
 * The classification is the one the intermittent-demand literature uses
 * (Syntetos–Boylan), on two measures an officer can be shown without a
 * statistics degree:
 *
 *  - **Average demand interval** — days per movement. Near one means the item
 *    moves daily; five means it moves about once a week.
 *  - **Squared coefficient of variation of the movement sizes** — whether those
 *    movements are all about the same size or wildly uneven.
 *
 * Those two questions separate the four cases that need different treatment, and
 * the rule is written down here rather than buried in a parameter search, so a
 * reviewer can disagree with it in a review rather than guess at it.
 *
 * `tsb` is reserved for an item whose *frequency* of use is falling, which the
 * other three methods handle badly: a phased-out item kept on Croston retains
 * its old rate for a long time, and the platform would keep recommending stock
 * for something the facility has stopped using.
 */

export type DemandPattern = 'empty' | 'smooth' | 'erratic' | 'intermittent' | 'lumpy' | 'fading';

/** Thresholds from the Syntetos–Boylan classification. */
const INTERMITTENT_INTERVAL = 1.32;
const ERRATIC_VARIABILITY = 0.49;

/** How far the rate of use must fall, as a share of days, to call an item fading. */
const FADING_OCCURRENCE_DROP = 0.05;

export interface Classification {
  readonly pattern: DemandPattern;
  readonly statistics: SeriesStatistics;
  /** Occurrence rate over the recent half of the history, less the earlier half. */
  readonly occurrenceTrend: number;
}

/** Occurrence rate of a slice of a series. */
const occurrenceRate = (points: readonly DemandPoint[]): number =>
  points.length === 0 ? 0 : points.filter((point) => point.issued > 0).length / points.length;

export function classifySeries(points: readonly DemandPoint[]): Classification {
  const statistics = seriesStatistics(points);
  const half = Math.floor(points.length / 2);
  const earlier = points.slice(0, half);
  const recent = points.slice(half);
  const occurrenceTrend = points.length < 14 ? 0 : occurrenceRate(recent) - occurrenceRate(earlier);

  if (statistics.movingDays === 0) {
    return { pattern: 'empty', statistics, occurrenceTrend };
  }

  if (
    statistics.averageDemandInterval >= INTERMITTENT_INTERVAL &&
    occurrenceTrend <= -FADING_OCCURRENCE_DROP
  ) {
    return { pattern: 'fading', statistics, occurrenceTrend };
  }

  const intermittent = statistics.averageDemandInterval >= INTERMITTENT_INTERVAL;
  const erratic = statistics.demandVariabilitySquared >= ERRATIC_VARIABILITY;

  if (intermittent && erratic) {
    return { pattern: 'lumpy', statistics, occurrenceTrend };
  }
  if (intermittent) {
    return { pattern: 'intermittent', statistics, occurrenceTrend };
  }
  if (erratic) {
    return { pattern: 'erratic', statistics, occurrenceTrend };
  }
  return { pattern: 'smooth', statistics, occurrenceTrend };
}

export interface SelectionOptions {
  /** A method the caller insists on, for comparing engines on identical inputs. */
  readonly requested?: ForecastMethod;
  /** Days in a repeating cycle. */
  readonly seasonLength: number;
}

/**
 * The method the pattern calls for.
 *
 * A caller may override it — that is how the backtest puts every engine on the
 * same footing — but nothing overrides it silently: the chosen method is
 * recorded on the forecast either way.
 */
export function chooseMethod(
  classification: Classification,
  historyDays: number,
  options: SelectionOptions,
): ForecastMethod {
  if (options.requested !== undefined) {
    return options.requested;
  }

  switch (classification.pattern) {
    case 'empty':
      return 'zero';
    case 'fading':
      return 'tsb';
    case 'intermittent':
    case 'lumpy':
      return 'croston-sba';
    case 'erratic':
      return 'moving-average';
    case 'smooth':
      // Three cycles before a seasonal shape is fitted: two is the arithmetic
      // minimum and one full cycle of evidence is not enough to trust it.
      return historyDays >= 3 * options.seasonLength ? 'holt-winters' : 'moving-average';
  }
}

/** Whether a series is too short to fit anything but a pooled prior. */
export const isColdStart = (
  classification: Classification,
  historyDays: number,
  minimumHistoryDays: number,
): boolean => classification.pattern === 'empty' || historyDays < minimumHistoryDays;
