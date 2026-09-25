import { countCensoredDays, detectCensoredIntervals } from '@civora/domain';
import type { Imputation } from '@civora/domain';

import type { DemandPoint, DemandSeries } from './types';

/**
 * Correcting censored demand before anything is fitted.
 *
 * This is the most important few dozen lines in the project. When a facility is
 * out of stock the ledger records that nothing was dispensed, and a model fitted
 * on that number learns the opposite of the truth: that stock-outs are periods
 * of *low demand*. It then under-orders during exactly the shortages it exists to
 * prevent, and it does so most confidently at the facilities that are already
 * worst served.
 *
 * The correction here replaces the dispensed quantity on censored days with an
 * estimate of what was wanted, so the fitted model sees need rather than supply.
 * Two things are deliberately kept separate:
 *
 *  - **Detection** lives in `@civora/domain` (`logic/censoring.ts`) and is a
 *    statement about the data: these days had no stock and the item was in use.
 *  - **Imputation** is a modelling choice, and it is recorded on every forecast
 *    it touches, with the number of days it replaced. An imputed history that is
 *    not recorded is indistinguishable from an invented one.
 *
 * The estimate is the facility's own rate on the days around the dry spell that
 * were *not* censored, which is the least assumption available: it needs no
 * external data and no shape assumption about demand. Only when the facility
 * offers no such day — an item that has never been in stock long enough to
 * dispense — does a peer rate get used, and the forecast says so.
 *
 * A Tobit-style latent-variable correction is the other textbook answer. It is
 * not implemented, and `imputation: 'tobit'` is never emitted rather than being
 * claimed.
 */

export type ImputationMethod = 'auto' | 'facility-mean' | 'peer-mean' | 'none';

export interface ImputationOptions {
  /**
   * Which estimate to use. `auto` prefers the facility's own observed rate and
   * falls back to a peer rate only when there is none.
   */
  readonly method?: ImputationMethod;
  /** Mean daily demand for comparable facilities, when one is available. */
  readonly peerDailyDemand?: number | null;
  /** On-hand at or below this level counts as unable to dispense. */
  readonly minimumDispenseLevel?: number;
  readonly activityWindowDays?: number;
}

export interface ImputedDemand {
  /** The series as fitted: identical to the input except across dry spells. */
  readonly points: readonly DemandPoint[];
  /** Censored days the detector found, whether or not each could be corrected. */
  readonly censoredDaysFound: number;
  /** Censored days actually replaced with an estimate. */
  readonly censoredDaysImputed: number;
  readonly imputation: Imputation;
  /** The daily rate the corrected days were set to. */
  readonly latentDailyDemand: number;
  /** Anything a reader is entitled to know about how the correction went. */
  readonly warnings: readonly string[];
}

export function imputeCensoredDemand(
  series: DemandSeries,
  options: ImputationOptions = {},
): ImputedDemand {
  const detection = {
    minimumDispenseLevel: options.minimumDispenseLevel ?? 0,
    activityWindowDays: options.activityWindowDays ?? 30,
  };

  const intervals = detectCensoredIntervals(series.points, detection);
  const censoredDaysFound = countCensoredDays(intervals);
  const warnings: string[] = [];

  if (censoredDaysFound > 0 && options.method === 'none') {
    // A caller may ask for the uncorrected series — the backtest does, to measure
    // what the correction is worth. The days are still counted and named, because
    // choosing not to correct is a decision the forecast has to disclose rather
    // than an absence of information.
    warnings.push(
      `${String(censoredDaysFound)} censored days were left uncorrected by request, so the fitted demand describes what this facility could dispense rather than what its patients needed`,
    );
    return {
      points: series.points,
      censoredDaysFound,
      censoredDaysImputed: 0,
      imputation: 'none',
      latentDailyDemand: 0,
      warnings,
    };
  }

  if (censoredDaysFound === 0) {
    return {
      points: series.points,
      censoredDaysFound: 0,
      censoredDaysImputed: 0,
      imputation: 'none',
      latentDailyDemand: 0,
      warnings,
    };
  }

  // The facility's own evidence, weighted by how long each dry spell lasted:
  // a fortnight without stock describes need better than a single bad day does.
  const weightedSum = intervals.reduce(
    (total, interval) => total + interval.estimatedDailyDemand * interval.days,
    0,
  );
  const facilityRate = weightedSum / censoredDaysFound;

  const peerRate = options.peerDailyDemand ?? 0;
  const requested = options.method ?? 'auto';

  const usepeer =
    requested === 'peer-mean' || (requested === 'auto' && facilityRate <= 0 && peerRate > 0);
  const rate = usepeer ? peerRate : facilityRate;
  const imputation: Imputation = rate > 0 ? (usepeer ? 'peer-mean' : 'facility-mean') : 'none';

  if (rate <= 0) {
    // Nothing to correct with. The days stay as recorded, and the count of them
    // travels with the forecast so a reader knows the history is censored even
    // though it could not be repaired.
    warnings.push(
      `${String(censoredDaysFound)} censored days could not be imputed: the facility recorded no dispensing around them and no peer rate was available, so its fitted demand is an understatement`,
    );
    return {
      points: series.points,
      censoredDaysFound,
      censoredDaysImputed: 0,
      imputation: 'none',
      latentDailyDemand: 0,
      warnings,
    };
  }

  if (imputation === 'peer-mean') {
    warnings.push(
      `the facility's own history contains no day on which this item could be dispensed, so ${String(censoredDaysFound)} censored days were imputed from comparable facilities`,
    );
  }

  const imputedDays = new Set<string>();
  for (const interval of intervals) {
    for (const point of series.points) {
      if (point.on <= interval.to && point.on >= interval.from) {
        imputedDays.add(point.on);
      }
    }
  }

  const points = series.points.map((point) =>
    imputedDays.has(point.on) ? { ...point, issued: rate } : point,
  );

  return {
    points,
    censoredDaysFound,
    censoredDaysImputed: imputedDays.size,
    imputation,
    latentDailyDemand: rate,
    warnings,
  };
}
