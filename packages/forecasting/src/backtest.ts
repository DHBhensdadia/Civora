import type { DateOnly, ForecastMethod } from '@civora/domain';

import { forecastDemand } from './engine';
import type { DemandSeries } from './types';

/**
 * Scoring forecasts against what actually happened.
 *
 * Four decisions make this worth reading, and each is a way the number could
 * have been made to flatter the platform:
 *
 *  1. **Forecasts are made from an origin and scored on days they never saw.**
 *     No in-sample fitting, no peeking forward.
 *  2. **The target is latent demand, not recorded issues.** Recorded issues are
 *     zero during a stock-out because nothing could be dispensed, so scoring
 *     against them would reward a model for predicting the shortage it failed to
 *     prevent. The generated world knows what was wanted; that is what is scored,
 *     and the recorded-issue error is reported beside it because in a deployment
 *     the latent number does not exist and the gap between them is the whole
 *     problem.
 *  3. **Every mandated baseline is run, including the ones that win.** A method
 *     that cannot beat a moving average on a series should not be used on it, and
 *     the report ranks methods so a reader can see when that happens.
 *  4. **The operational claim is a warning test, not a counterfactual.** It asks
 *     whether the platform would have flagged a facility *before* demand went
 *     unmet. That is a weaker claim than "a different ordering policy would have
 *     avoided it", and it is stated as the weaker claim: re-simulating
 *     procurement under a different policy is not built.
 */

export interface BacktestSeries {
  readonly series: DemandSeries;
  /**
   * What was wanted each day, whether or not it could be dispensed.
   *
   * Equal to `issued` outside a stock-out, and above it inside one.
   */
  readonly latent: readonly number[];
}

export interface BacktestOptions {
  readonly horizonDays: number;
  /** Days between forecast origins. */
  readonly strideDays: number;
  /** Baselines scored alongside the engine's own choice. */
  readonly baselines: readonly ForecastMethod[];
  /** Origins are only taken once this much history exists. */
  readonly minimumHistoryDays: number;
  /** At most this many origins per series, taken from the end of the window. */
  readonly maxOriginsPerSeries: number;
  readonly bootstrapReplications: number;
  readonly seasonLength: number;
  /**
   * The quantile the upper bound claims to be. Nominal coverage for it is this.
   */
  readonly coverageLevel: number;
  /**
   * How far achieved coverage may sit from nominal and still count as calibrated.
   *
   * Five percentage points, which is the conventional band for a prediction
   * interval and, more importantly, is small enough that a genuinely mis-calibrated
   * bound cannot hide inside it. Stated as a number rather than described as
   * "approximately", because the whole value of a coverage figure is being able
   * to say whether it passed.
   */
  readonly coverageTolerance: number;
}

/**
 * How far achieved p90 coverage may sit from nominal and still count as calibrated.
 *
 * Five percentage points, the conventional band for a prediction interval and
 * small enough that a genuinely mis-calibrated bound cannot hide inside it.
 * Exported so that the calibration test and the report cannot disagree about what
 * "within tolerance" means.
 */
export const BACKTEST_COVERAGE_TOLERANCE_GUARD = 0.05;

export const DEFAULT_BACKTEST_OPTIONS: BacktestOptions = {
  horizonDays: 7,
  strideDays: 7,
  baselines: ['zero', 'moving-average', 'seasonal-naive', 'croston'],
  minimumHistoryDays: 28,
  maxOriginsPerSeries: 6,
  // Lower than the engine's default: the backtest fits many thousands of times,
  // and the quantile of 100 resampled paths is stable enough to rank methods on.
  bootstrapReplications: 100,
  seasonLength: 7,
  coverageLevel: 0.9,
  coverageTolerance: BACKTEST_COVERAGE_TOLERANCE_GUARD,
};

export interface MethodScore {
  /** The method, or `engine` for the classification's own choice. */
  readonly method: ForecastMethod | 'engine';
  readonly forecasts: number;
  /** Pinball loss at the median: the proper scoring rule for a point forecast. */
  readonly pinball50: number;
  /** Pinball loss at the upper bound. */
  readonly pinball90: number;
  readonly meanAbsoluteError: number;
  /**
   * Mean error divided by the demand that actually occurred on that day.
   *
   * Reported beside the absolute error because the absolute figure is dominated
   * by whichever item moves in the largest numbers, and a method that is right
   * about a high-volume antibiotic and useless for a vaccine should not look
   * better than its opposite.
   */
  readonly meanRelativeError: number;
  /** Mean absolute error of the seasonal-naive benchmark over the same days. */
  readonly baselineAbsoluteError: number;
  /** The ratio of the two, so error has a scale that does not depend on the item. */
  readonly mase: number;
  /** Share of days on which the upper bound covered what was actually wanted. */
  readonly coverage90: number;
  /**
   * Share of days on which it covered what was *recorded*.
   *
   * The residuals the bound is built from come from recorded history, so this is
   * the calibration the interval can actually be judged on; the latent figure
   * above is harder because a stock-out also hides demand the platform never saw.
   */
  readonly recordedCoverage90: number;
  /** Mean absolute error against the *recorded* issues, for comparison. */
  readonly recordedMeanAbsoluteError: number;
}

export interface CensoringPair {
  readonly corrected: MethodScore;
  readonly uncorrected: MethodScore;
  /** Mean demand the corrected engine predicted, per scored day. */
  readonly correctedMean: number;
  readonly uncorrectedMean: number;
  /** Mean demand that actually occurred across the same days. */
  readonly actualMean: number;
  readonly forecastDays: number;
}

export interface CensoringComparison {
  /**
   * Every origin scored.
   *
   * The correction can only move a forecast whose history contained a stock-out,
   * so across a population where most series never ran dry this figure is
   * dominated by series the correction never touched. It is reported anyway,
   * because a comparison that only showed the favourable population would be an
   * advertisement rather than a measurement.
   */
  readonly all: CensoringPair;
  /** Only the origins whose history contained a detected stock-out. */
  readonly affected: CensoringPair;
  /**
   * Only the origins whose *horizon* contained days on which demand went unmet.
   *
   * The population the correction is aimed at: a forecast made into or through a
   * shortage, which is when predicting need rather than supply changes the
   * number an officer would act on. The two populations are different on
   * purpose — a stock-out a hundred days back does not change today's forecast,
   * and a shortage arriving tomorrow need not have a censored day behind it
   * (stock can run out because a delivery failed, not because demand rose).
   */
  readonly horizon: CensoringPair;
  /** Censored days the engine found across the scored histories. */
  readonly censoredDays: number;
  /** Origins whose history contained at least one censored day. */
  readonly affectedOrigins: number;
  /** Origins whose horizon contained at least one day of unmet demand. */
  readonly horizonOrigins: number;
}

export interface WarningScore {
  readonly originsScored: number;
  /** Origins within whose horizon demand actually went unmet. */
  readonly shortages: number;
  /** Those the upper bound flagged before the first unmet day. */
  readonly warned: number;
  /** Those nothing flagged. */
  readonly missed: number;
  /** Warnings after which no demand went unmet. */
  readonly falseAlarms: number;
  /** Mean days between the origin and the first day demand went unmet. */
  readonly meanAdvanceDays: number;
}

/**
 * Whether the upper bound is the quantile it claims to be.
 *
 * Reported against both targets, and the split is the honest part. The residuals
 * the interval is bootstrapped from are differences between a fit and the
 * *recorded* history, so coverage against recorded issues is the calibration the
 * model can actually be judged on. Coverage against latent demand will be lower
 * whenever the horizon contains a stock-out, because the target then includes
 * demand the platform never observed and the interval was never widened for.
 * Both are published; only one of them is a pass or fail.
 */
export interface CalibrationSummary {
  readonly nominal: number;
  readonly tolerance: number;
  readonly achievedLatent: number;
  readonly achievedRecorded: number;
  readonly withinToleranceLatent: boolean;
  readonly withinToleranceRecorded: boolean;
  readonly days: number;
  readonly note: string;
}

export interface BacktestReport {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly series: number;
  readonly origins: number;
  readonly horizonDays: number;
  readonly scoredDays: number;
  readonly scores: readonly MethodScore[];
  readonly censoring: CensoringComparison;
  readonly calibration: CalibrationSummary;
  readonly warning: WarningScore;
  readonly elapsedMs: number;
}

interface Accumulator {
  forecasts: number;
  pinball50: number;
  pinball90: number;
  absoluteError: number;
  relativeError: number;
  baselineAbsoluteError: number;
  recordedAbsoluteError: number;
  covered: number;
  recordedCovered: number;
}

const emptyAccumulator = (): Accumulator => ({
  forecasts: 0,
  pinball50: 0,
  pinball90: 0,
  absoluteError: 0,
  relativeError: 0,
  baselineAbsoluteError: 0,
  recordedAbsoluteError: 0,
  covered: 0,
  recordedCovered: 0,
});

/** Pinball loss: the scoring rule a true quantile minimises. */
const pinball = (actual: number, predicted: number, level: number): number =>
  actual >= predicted ? level * (actual - predicted) : (1 - level) * (predicted - actual);

const scoreOf = (method: ForecastMethod | 'engine', accumulator: Accumulator): MethodScore => {
  const divisor = Math.max(1, accumulator.forecasts);
  return {
    method,
    forecasts: accumulator.forecasts,
    pinball50: accumulator.pinball50 / divisor,
    pinball90: accumulator.pinball90 / divisor,
    meanAbsoluteError: accumulator.absoluteError / divisor,
    meanRelativeError: accumulator.relativeError / divisor,
    baselineAbsoluteError: accumulator.baselineAbsoluteError / divisor,
    mase:
      accumulator.baselineAbsoluteError === 0
        ? 0
        : accumulator.absoluteError / accumulator.baselineAbsoluteError,
    coverage90: accumulator.forecasts === 0 ? 0 : accumulator.covered / accumulator.forecasts,
    recordedCoverage90:
      accumulator.forecasts === 0 ? 0 : accumulator.recordedCovered / accumulator.forecasts,
    recordedMeanAbsoluteError: accumulator.recordedAbsoluteError / divisor,
  };
};

/** The origins to forecast from: the last days of the window, walked backwards. */
const originsOf = (length: number, options: BacktestOptions): readonly number[] => {
  const lastUsable = length - options.horizonDays - 1;
  const span = options.strideDays * (options.maxOriginsPerSeries - 1);
  const first = Math.max(options.minimumHistoryDays, lastUsable - span);

  const origins: number[] = [];
  for (let index = lastUsable; index >= first; index -= options.strideDays) {
    origins.push(index);
  }
  return origins.reverse();
};

/** A mutable bucket for the corrected-against-uncorrected comparison. */
interface ComparisonBucket {
  corrected: Accumulator;
  uncorrected: Accumulator;
  correctedTotal: number;
  uncorrectedTotal: number;
  actualTotal: number;
  forecastDays: number;
}

const emptyBucket = (): ComparisonBucket => ({
  corrected: emptyAccumulator(),
  uncorrected: emptyAccumulator(),
  correctedTotal: 0,
  uncorrectedTotal: 0,
  actualTotal: 0,
  forecastDays: 0,
});

const pairOf = (bucket: ComparisonBucket): CensoringPair => ({
  corrected: scoreOf('engine', bucket.corrected),
  uncorrected: scoreOf('engine', bucket.uncorrected),
  correctedMean: bucket.correctedTotal / Math.max(1, bucket.forecastDays),
  uncorrectedMean: bucket.uncorrectedTotal / Math.max(1, bucket.forecastDays),
  actualMean: bucket.actualTotal / Math.max(1, bucket.forecastDays),
  forecastDays: bucket.forecastDays,
});

export function runBacktest(
  entries: readonly BacktestSeries[],
  options: BacktestOptions = DEFAULT_BACKTEST_OPTIONS,
): BacktestReport {
  const startedAt = Date.now();
  const accumulators = new Map<string, Accumulator>();
  const comparison = { all: emptyBucket(), affected: emptyBucket(), horizon: emptyBucket() };
  const warning = {
    originsScored: 0,
    shortages: 0,
    warned: 0,
    missed: 0,
    falseAlarms: 0,
    advanceDays: 0,
  };

  let censoredDays = 0;
  let affectedOrigins = 0;
  let horizonOrigins = 0;
  let scoredDays = 0;
  let origins = 0;
  let firstDay: DateOnly | null = null;
  let lastDay: DateOnly | null = null;

  const accumulate = (key: string, add: (accumulator: Accumulator) => void): void => {
    const accumulator = accumulators.get(key) ?? emptyAccumulator();
    accumulators.set(key, accumulator);
    add(accumulator);
  };

  /** Score one forecast day, into whichever bucket is being filled. */
  const record = (
    bucket: Accumulator,
    observed: {
      readonly actual: number;
      readonly recorded: number;
      readonly median: number;
      readonly upper: number;
      readonly baselineError: number;
    },
  ): void => {
    bucket.forecasts += 1;
    bucket.pinball50 += pinball(observed.actual, observed.median, 0.5);
    bucket.pinball90 += pinball(observed.actual, observed.upper, 0.9);
    bucket.absoluteError += Math.abs(observed.actual - observed.median);
    bucket.relativeError +=
      Math.abs(observed.actual - observed.median) / Math.max(1, observed.actual);
    bucket.recordedAbsoluteError += Math.abs(observed.recorded - observed.median);
    bucket.baselineAbsoluteError += observed.baselineError;
    if (observed.actual <= observed.upper) {
      bucket.covered += 1;
    }
    if (observed.recorded <= observed.upper) {
      bucket.recordedCovered += 1;
    }
  };

  /** The same, for a comparison that only has a point forecast to score. */
  const recordPoint = (
    bucket: Accumulator,
    actual: number,
    recorded: number,
    median: number,
  ): void => {
    bucket.forecasts += 1;
    bucket.pinball50 += pinball(actual, median, 0.5);
    bucket.absoluteError += Math.abs(actual - median);
    bucket.relativeError += Math.abs(actual - median) / Math.max(1, actual);
    bucket.recordedAbsoluteError += Math.abs(recorded - median);
  };

  const request = (
    facilityId: DemandSeries['facilityId'],
    itemId: DemandSeries['itemId'],
    asOf: DateOnly,
  ) => ({
    facilityId,
    itemId,
    asOf,
    horizonDays: options.horizonDays,
    // One seed per series: the comparison between methods must not differ by
    // luck of the resampling.
    seed: `backtest:${facilityId}:${itemId}`,
    synthetic: true,
    provenance: { kind: 'derived', reference: 'backtest' } as const,
  });

  for (const entry of entries) {
    const { series, latent } = entry;
    const recorded = series.points.map((point) => point.issued);
    const seriesOrigins = originsOf(recorded.length, options);
    if (seriesOrigins.length === 0) {
      continue;
    }

    for (const origin of seriesOrigins) {
      const asOf = series.points[origin]?.on;
      if (asOf === undefined) {
        continue;
      }

      const history: DemandSeries = { ...series, points: series.points.slice(0, origin + 1) };
      const engineOutcome = forecastDemand(
        history,
        request(series.facilityId, series.itemId, asOf),
        {
          bootstrapReplications: options.bootstrapReplications,
          seasonLength: options.seasonLength,
        },
      );

      const uncorrectedOutcome = forecastDemand(
        history,
        request(series.facilityId, series.itemId, asOf),
        {
          imputation: 'none',
          bootstrapReplications: options.bootstrapReplications,
          seasonLength: options.seasonLength,
        },
      );

      const baselineOutcomes = options.baselines.map((baseline) => ({
        baseline,
        outcome: forecastDemand(history, request(series.facilityId, series.itemId, asOf), {
          requestedMethod: baseline,
          bootstrapReplications: options.bootstrapReplications,
          seasonLength: options.seasonLength,
        }),
      }));

      const censoredHereDays =
        engineOutcome.forecast.features.find((feature) => feature.name === 'censoredDaysFound')
          ?.value ?? 0;

      // The day demand first went unmet inside the horizon, which is both the
      // population split below and the advance the warning bought.
      let firstUnmet = -1;
      for (let step = 0; step < options.horizonDays; step += 1) {
        const dayIndex = origin + 1 + step;
        if ((latent[dayIndex] ?? 0) > (recorded[dayIndex] ?? 0) + 1e-9) {
          firstUnmet = step;
          break;
        }
      }

      for (let step = 0; step < options.horizonDays; step += 1) {
        const dayIndex = origin + 1 + step;
        const actual = latent[dayIndex];
        const recordedActual = recorded[dayIndex];
        const baselineValue = latent[dayIndex - options.seasonLength];
        const engineMedian = engineOutcome.forecast.p50[step];
        const engineUpper = engineOutcome.forecast.p90[step];

        if (actual === undefined || engineMedian === undefined || engineUpper === undefined) {
          continue;
        }

        const baselineError = baselineValue === undefined ? 0 : Math.abs(actual - baselineValue);
        const wasRecorded = recordedActual ?? 0;

        accumulate('engine', (accumulator) => {
          record(accumulator, {
            actual,
            recorded: wasRecorded,
            median: engineMedian,
            upper: engineUpper,
            baselineError,
          });
        });

        for (const { baseline, outcome } of baselineOutcomes) {
          const median = outcome.forecast.p50[step];
          const upper = outcome.forecast.p90[step];
          if (median === undefined || upper === undefined) {
            continue;
          }

          accumulate(baseline, (accumulator) => {
            record(accumulator, { actual, recorded: wasRecorded, median, upper, baselineError });
          });
        }

        const uncorrectedMedian = uncorrectedOutcome.forecast.p50[step];
        if (uncorrectedMedian !== undefined) {
          const buckets = [comparison.all];
          if (censoredHereDays > 0) {
            buckets.push(comparison.affected);
          }
          if (firstUnmet >= 0) {
            buckets.push(comparison.horizon);
          }

          for (const bucket of buckets) {
            recordPoint(bucket.corrected, actual, wasRecorded, engineMedian);
            recordPoint(bucket.uncorrected, actual, wasRecorded, uncorrectedMedian);
            bucket.correctedTotal += engineMedian;
            bucket.uncorrectedTotal += uncorrectedMedian;
            bucket.actualTotal += actual;
            bucket.forecastDays += 1;
          }

          scoredDays += 1;
        }
      }

      censoredDays += censoredHereDays;
      if (censoredHereDays > 0) {
        affectedOrigins += 1;
      }
      if (firstUnmet >= 0) {
        horizonOrigins += 1;
      }

      // The operational question: would the platform have flagged this in advance?
      const onHand = series.points[origin]?.onHand ?? 0;
      const throughHorizon = engineOutcome.cumulativeP90[options.horizonDays - 1] ?? 0;

      warning.originsScored += 1;
      if (firstUnmet >= 0) {
        warning.shortages += 1;
        if (throughHorizon > onHand) {
          warning.warned += 1;
          warning.advanceDays += firstUnmet;
        } else {
          warning.missed += 1;
        }
      } else if (throughHorizon > onHand) {
        warning.falseAlarms += 1;
      }

      origins += 1;
      firstDay = firstDay ?? series.points[0]?.on ?? null;
      lastDay = lastDay ?? series.points[series.points.length - 1]?.on ?? null;
    }
  }

  const engineAccumulator = accumulators.get('engine') ?? emptyAccumulator();
  const achievedRecorded =
    engineAccumulator.forecasts === 0
      ? 0
      : engineAccumulator.recordedCovered / engineAccumulator.forecasts;
  const achievedLatent =
    engineAccumulator.forecasts === 0 ? 0 : engineAccumulator.covered / engineAccumulator.forecasts;

  return {
    from: firstDay ?? '1970-01-01',
    to: lastDay ?? '1970-01-01',
    series: entries.length,
    origins,
    horizonDays: options.horizonDays,
    scoredDays,
    scores: [...accumulators]
      .map(([key, accumulator]) =>
        scoreOf(key === 'engine' ? 'engine' : (key as ForecastMethod), accumulator),
      )
      .sort((left, right) => left.mase - right.mase),
    censoring: {
      all: pairOf(comparison.all),
      affected: pairOf(comparison.affected),
      horizon: pairOf(comparison.horizon),
      censoredDays,
      affectedOrigins,
      horizonOrigins,
    },
    calibration: {
      nominal: options.coverageLevel,
      tolerance: options.coverageTolerance,
      achievedLatent,
      achievedRecorded,
      withinToleranceLatent:
        Math.abs(achievedLatent - options.coverageLevel) <= options.coverageTolerance,
      withinToleranceRecorded:
        Math.abs(achievedRecorded - options.coverageLevel) <= options.coverageTolerance,
      days: engineAccumulator.forecasts,
      note: 'coverage is measured against recorded issues, which is the series the residuals came from, and against latent demand, which is the series the platform is for',
    },
    warning: {
      ...warning,
      meanAdvanceDays: warning.warned === 0 ? 0 : warning.advanceDays / warning.warned,
    },
    elapsedMs: Date.now() - startedAt,
  };
}
