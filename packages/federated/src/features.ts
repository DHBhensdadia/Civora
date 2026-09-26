import type { Imputation } from '@civora/domain';
import { imputeCensoredDemand, seriesFeatures } from '@civora/forecasting';
import type { DemandSeries } from '@civora/forecasting';

import type { FederatedSample } from './types';

/**
 * The feature schema, taken from the forecaster rather than restated beside it.
 *
 * Phase 4 already names the numbers it fits a series on, and those names are a
 * function's own output: `seriesFeatures` returns `{name, value}` pairs. This
 * module therefore *calls* it — the series-level block of every federated sample
 * is that call's values, in that call's order — instead of copying the list,
 * which is how the two would eventually disagree. The derived block (lags,
 * rolling means, annual harmonics) is named here and appended.
 *
 * The samples are built from a silo's own records, and they stay in the silo:
 * only parameters and counts cross the boundary (see `payload.ts`).
 */

/** The derived block of the schema. Names, in the order the builder emits them. */
export const DERIVED_FEATURE_NAMES = [
  'lag1',
  'lag2',
  'lag3',
  'rolling7',
  'rolling28',
  'doySin',
  'doyCos',
] as const;

/**
 * Phase 4's series-level names, read off the function itself.
 *
 * `seriesFeatures` is total — an empty series has an answer rather than an
 * exception — so calling it here yields the schema without inventing a series.
 */
export const SERIES_FEATURE_NAMES: readonly string[] = seriesFeatures([]).map(
  (feature) => feature.name,
);

/** The whole schema: Phase 4's block, then the derived one. */
export const FEDERATED_FEATURE_NAMES: readonly string[] = [
  ...SERIES_FEATURE_NAMES,
  ...DERIVED_FEATURE_NAMES,
];

/** How many days of history a sample needs before it can be built at all. */
export const MINIMUM_HISTORY_DAYS = 28;

/** Samples taken per series, most recent first. Bounds a long series' cost. */
export const MAX_SAMPLES_PER_SERIES = 250;

/** Days of trailing history the series-level statistics are read over. */
export const SEASONAL_WINDOW_DAYS = 56;

export interface SiloSampleOptions {
  readonly minHistoryDays?: number;
  readonly maxSamplesPerSeries?: number;
  readonly seasonalWindowDays?: number;
  /** Mean daily demand of comparable facilities, for the censoring fallback. */
  readonly peerDailyDemand?: number | null;
}

export interface BuiltSiloSamples {
  readonly featureNames: readonly string[];
  readonly samples: readonly FederatedSample[];
  /** Series that produced at least one sample. */
  readonly seriesCount: number;
  /** Series too short to produce any, reported rather than silently dropped. */
  readonly shortSeries: number;
  readonly censoredDaysFound: number;
  readonly censoredDaysImputed: number;
  /** The correction actually applied, as the imputer stated it. */
  readonly imputation: Imputation;
}

/** Day of year from a `YYYY-MM-DD` string, without a clock and without a leap day. */
const dayOfYearOf = (on: string): number => {
  const month = Number(on.slice(5, 7));
  const day = Number(on.slice(8, 10));
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return (cumulative[month - 1] ?? 0) + day;
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

/**
 * Turn a silo's series into training rows.
 *
 * The target is **censored-demand-corrected**: a facility that was out of stock
 * recorded zero, and training on that number teaches the model that shortages
 * are periods of low demand. Phase 4's imputer repairs the history first and
 * states what it replaced, and the same corrected points feed the lags, so the
 * model does not read the raw zeros through a side door.
 */
export function buildSiloSamples(
  series: readonly DemandSeries[],
  options: SiloSampleOptions = {},
): BuiltSiloSamples {
  const minHistory = options.minHistoryDays ?? MINIMUM_HISTORY_DAYS;
  const maxSamples = options.maxSamplesPerSeries ?? MAX_SAMPLES_PER_SERIES;
  const seasonalWindow = options.seasonalWindowDays ?? SEASONAL_WINDOW_DAYS;

  const samples: FederatedSample[] = [];
  let seriesCount = 0;
  let shortSeries = 0;
  let censoredDaysFound = 0;
  let censoredDaysImputed = 0;
  const imputations = new Set<Imputation>();

  for (const entry of series) {
    const imputed = imputeCensoredDemand(entry, {
      peerDailyDemand: options.peerDailyDemand ?? null,
    });
    censoredDaysFound += imputed.censoredDaysFound;
    censoredDaysImputed += imputed.censoredDaysImputed;
    imputations.add(imputed.imputation);

    const points = imputed.points;
    if (points.length <= minHistory) {
      shortSeries += 1;
      continue;
    }

    const rows: FederatedSample[] = [];
    for (let day = minHistory; day < points.length; day += 1) {
      const current = points[day];
      if (current === undefined) {
        continue;
      }

      // Series-level statistics over the trailing window that *ends before* the
      // day being predicted, so nothing about the target leaks into its row.
      const history = points.slice(Math.max(0, day - seasonalWindow), day);
      const seriesBlock = seriesFeatures(history).map((feature) => feature.value);

      const issuedAt = (offset: number): number => points[day - offset]?.issued ?? 0;
      const angle = (2 * Math.PI * dayOfYearOf(current.on)) / 365;

      rows.push({
        features: [
          ...seriesBlock,
          issuedAt(1),
          issuedAt(2),
          issuedAt(3),
          mean([
            issuedAt(1),
            issuedAt(2),
            issuedAt(3),
            issuedAt(4),
            issuedAt(5),
            issuedAt(6),
            issuedAt(7),
          ]),
          mean([
            issuedAt(1),
            issuedAt(2),
            issuedAt(3),
            issuedAt(4),
            issuedAt(5),
            issuedAt(6),
            issuedAt(7),
            issuedAt(8),
            issuedAt(9),
            issuedAt(10),
            issuedAt(11),
            issuedAt(12),
            issuedAt(13),
            issuedAt(14),
            issuedAt(15),
            issuedAt(16),
            issuedAt(17),
            issuedAt(18),
            issuedAt(19),
            issuedAt(20),
            issuedAt(21),
            issuedAt(22),
            issuedAt(23),
            issuedAt(24),
            issuedAt(25),
            issuedAt(26),
            issuedAt(27),
            issuedAt(28),
          ]),
          Math.sin(angle),
          Math.cos(angle),
        ],
        target: current.issued,
      });
    }

    if (rows.length > 0) {
      seriesCount += 1;
      // The most recent rows: a model fitted on a facility's first month is not
      // a model of that facility today.
      samples.push(...rows.slice(Math.max(0, rows.length - maxSamples)));
    }
  }

  const imputation: Imputation =
    censoredDaysImputed > 0
      ? imputations.has('peer-mean')
        ? 'peer-mean'
        : 'facility-mean'
      : 'none';

  return {
    featureNames: FEDERATED_FEATURE_NAMES,
    samples,
    seriesCount,
    shortSeries,
    censoredDaysFound,
    censoredDaysImputed,
    imputation,
  };
}
