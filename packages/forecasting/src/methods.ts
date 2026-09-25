import type { ForecastMethod } from '@civora/domain';

import { mean } from './series';
import type { FittedSeries, ForecastFeature } from './types';

/**
 * The statistical engines.
 *
 * Each one is a filter rather than a single number: it produces the forecast for
 * the horizon *and* the prediction it would have made on each day it has seen.
 * Those predictions are what the residual bootstrap measures uncertainty from,
 * and producing them in the same pass is not an optimisation — a residual series
 * computed from a separately fitted model is a second model, and the intervals
 * would describe that one instead.
 *
 * All of them are pure, total, and free of clock or network access. A method that
 * cannot answer from the history it was given returns zeros rather than failing,
 * because the facility with four days of history is a case the platform has to
 * survive, not one it may crash on.
 */

export interface FitOptions {
  /** Days to forecast. */
  readonly horizon: number;
  /** Days in the repeating cycle. Seven for a week of facility activity. */
  readonly seasonLength?: number;
  /** Days averaged by the moving-average method. */
  readonly window?: number;
  /** Smoothing constant for the level. */
  readonly alpha?: number;
  /** Smoothing constant for the trend (Holt-Winters) or the interval (TSB). */
  readonly beta?: number;
  /** Smoothing constant for the seasonal component. */
  readonly gamma?: number;
}

const DEFAULT_SEASON_LENGTH = 7;
const DEFAULT_WINDOW_DAYS = 28;
const DEFAULT_ALPHA = 0.1;
const DEFAULT_BETA = 0.1;
const DEFAULT_GAMMA = 0.3;

const zeros = (count: number): readonly number[] =>
  Array.from({ length: Math.max(0, count) }, () => 0);

/** No demand expected. The baseline every other method has to beat. */
export function fitZero(values: readonly number[], options: FitOptions): FittedSeries {
  return {
    rate: zeros(options.horizon),
    oneStepAhead: zeros(values.length),
    parameters: [{ name: 'method', value: 0 }],
    warmup: values.length,
  };
}

export function fitMovingAverage(values: readonly number[], options: FitOptions): FittedSeries {
  const window = Math.max(
    1,
    Math.min(options.window ?? DEFAULT_WINDOW_DAYS, Math.max(1, values.length)),
  );

  const oneStepAhead = values.map((_, index) =>
    index === 0 ? 0 : mean(values.slice(Math.max(0, index - window), index)),
  );

  const recent = mean(values.slice(Math.max(0, values.length - window)));

  return {
    rate: Array.from({ length: options.horizon }, () => recent),
    oneStepAhead,
    parameters: [
      { name: 'window', value: window },
      { name: 'recentDailyMean', value: recent },
    ],
    warmup: Math.min(window, values.length),
  };
}

export function fitSeasonalNaive(values: readonly number[], options: FitOptions): FittedSeries {
  const season = Math.max(1, options.seasonLength ?? DEFAULT_SEASON_LENGTH);
  const lastSeason = values.slice(Math.max(0, values.length - season));

  const oneStepAhead = values.map((_, index) =>
    index >= season ? (values[index - season] ?? 0) : 0,
  );

  const rate =
    lastSeason.length === 0
      ? zeros(options.horizon)
      : Array.from(
          { length: options.horizon },
          (_, step) => lastSeason[step % lastSeason.length] ?? 0,
        );

  return {
    rate,
    oneStepAhead,
    parameters: [
      { name: 'seasonLength', value: season },
      { name: 'seasonDays', value: lastSeason.length },
    ],
    warmup: Math.min(season, values.length),
  };
}

/**
 * Croston's method, with or without the Syntetos–Boylan correction.
 *
 * Built for demand that arrives as isolated events: it smooths the *size* of a
 * movement and the *interval* between movements separately, and predicts their
 * ratio, rather than pretending a fortnight of zeros is a fortnight of low daily
 * demand. Facilities order a box of amoxicillin when they order it, and an
 * average that cannot tell "ten units every ten days" from "one unit a day" gets
 * both the order quantity and the timing wrong.
 *
 * The SBA correction multiplies the estimate by `(1 - alpha/2)`, which removes
 * the small positive bias plain Croston carries. It is the variant this platform
 * selects by default; plain Croston is kept so the two can be compared on the
 * same data rather than argued about.
 */
export function fitCroston(
  values: readonly number[],
  options: FitOptions,
  variant: 'classic' | 'sba',
): FittedSeries {
  const alpha = Math.min(1, Math.max(0.01, options.alpha ?? DEFAULT_ALPHA));
  const correction = variant === 'sba' ? 1 - alpha / 2 : 1;

  let level = 0;
  let interval = 0;
  let lastMovement = 0;
  let started = false;
  let movements = 0;
  let firstMovement = -1;

  const oneStepAhead = values.map((value, index) => {
    const prediction = interval > 0 ? (level / interval) * correction : 0;

    if (value > 0) {
      const gap = Math.max(1, index - lastMovement);
      if (!started) {
        level = value;
        interval = gap;
        started = true;
        firstMovement = index;
      } else {
        level += alpha * (value - level);
        interval += alpha * (gap - interval);
      }
      lastMovement = index;
      movements += 1;
    }

    return prediction;
  });

  const rate = interval > 0 ? (level / interval) * correction : 0;

  return {
    rate: Array.from({ length: options.horizon }, () => Math.max(0, rate)),
    oneStepAhead,
    parameters: [
      { name: 'alpha', value: alpha },
      { name: 'interval', value: interval },
      { name: 'level', value: level },
      { name: 'movements', value: movements },
      { name: 'sbaCorrection', value: correction },
    ],
    warmup: firstMovement < 0 ? values.length : firstMovement + 1,
  };
}

/**
 * Teunter–Syntetos–Babai: the same idea as Croston, with the probability of a
 * movement updated on *every* day rather than only on the days that moved.
 *
 * Croston updates its interval only when demand arrives, so a facility that has
 * genuinely stopped using an item keeps its old rate for a long time. TSB decays
 * the probability of use as the silent days accumulate, which is what makes it
 * the right method for an item being phased out — the reason the platform
 * carries both rather than picking a favourite.
 */
export function fitTsb(values: readonly number[], options: FitOptions): FittedSeries {
  const alpha = Math.min(1, Math.max(0.01, options.alpha ?? DEFAULT_ALPHA));
  const beta = Math.min(1, Math.max(0.01, options.beta ?? DEFAULT_BETA));

  const moving = values.filter((value) => value > 0);
  let size = moving.length === 0 ? 0 : mean(moving);
  let probability = values.length === 0 ? 0 : moving.length / values.length;

  const oneStepAhead = values.map((value) => {
    const prediction = probability * size;

    if (value > 0) {
      size = size === 0 ? value : size + alpha * (value - size);
      probability += beta * (1 - probability);
    } else {
      probability += beta * (0 - probability);
    }

    return prediction;
  });

  const rate = probability * size;

  return {
    rate: Array.from({ length: options.horizon }, () => Math.max(0, rate)),
    oneStepAhead,
    parameters: [
      { name: 'alpha', value: alpha },
      { name: 'beta', value: beta },
      { name: 'probability', value: probability },
      { name: 'sizeWhenMoving', value: size },
    ],
    warmup: Math.min(values.length, DEFAULT_SEASON_LENGTH),
  };
}

/**
 * Additive Holt-Winters with a weekly cycle, for items that are consumed every
 * day and differently on different days of the week.
 *
 * Given less than two full cycles it degrades to Holt's linear trend and records
 * `seasonLength: 1`, rather than inventing a seasonal shape from one week. Scale
 * matters here: an outpatient department is quiet on Sunday and busy on Monday,
 * and a method blind to that orders for the average every day.
 */
export function fitHoltWinters(values: readonly number[], options: FitOptions): FittedSeries {
  const alpha = Math.min(1, Math.max(0.01, options.alpha ?? DEFAULT_GAMMA));
  const beta = Math.min(1, Math.max(0, options.beta ?? 0.05));
  const gamma = Math.min(1, Math.max(0, options.gamma ?? DEFAULT_GAMMA));

  const requestedSeason = Math.max(1, options.seasonLength ?? DEFAULT_SEASON_LENGTH);
  const season = values.length >= 2 * requestedSeason ? requestedSeason : 1;

  const firstCycle = values.slice(0, season);
  const firstMean = mean(firstCycle);
  const secondMean = season > 1 ? mean(values.slice(season, 2 * season)) : firstMean;

  let level = firstMean;
  let trend = season > 1 ? (secondMean - firstMean) / season : 0;
  const seasonal = firstCycle.map((value) => value - firstMean);

  const oneStepAhead = values.map((value, index) => {
    const position = index % season;
    const seasonalValue = seasonal[position] ?? 0;
    const prediction = Math.max(0, level + trend + seasonalValue);

    const previousLevel = level;
    level = alpha * (value - seasonalValue) + (1 - alpha) * (level + trend);
    trend = beta * (level - previousLevel) + (1 - beta) * trend;
    seasonal[position] = gamma * (value - level) + (1 - gamma) * seasonalValue;

    return prediction;
  });

  const rate = Array.from({ length: options.horizon }, (_, step) => {
    const position = (values.length + step) % season;
    return Math.max(0, level + trend * (step + 1) + (seasonal[position] ?? 0));
  });

  return {
    rate,
    oneStepAhead,
    parameters: [
      { name: 'seasonLength', value: season },
      { name: 'alpha', value: alpha },
      { name: 'beta', value: beta },
      { name: 'gamma', value: gamma },
      { name: 'level', value: level },
      { name: 'trend', value: trend },
    ],
    warmup: Math.min(values.length, 2 * season),
  };
}

/** Fit the named method. The only place the dispatch exists. */
export function fitMethod(
  method: ForecastMethod,
  values: readonly number[],
  options: FitOptions,
): FittedSeries {
  switch (method) {
    case 'zero':
      return fitZero(values, options);
    case 'moving-average':
      return fitMovingAverage(values, options);
    case 'seasonal-naive':
      return fitSeasonalNaive(values, options);
    case 'croston':
      return fitCroston(values, options, 'classic');
    case 'croston-sba':
      return fitCroston(values, options, 'sba');
    case 'tsb':
      return fitTsb(values, options);
    case 'holt-winters':
      return fitHoltWinters(values, options);
    case 'pooled-prior':
      // Fitted by `priors.ts` from other facilities' series, which this function
      // has no access to by design: a method must not reach outside its inputs.
      return fitZero(values, options);
  }
}

/** Differences between what happened and what was predicted, past the warm-up. */
export const residualsOf = (values: readonly number[], fitted: FittedSeries): readonly number[] =>
  values
    .map((value, index) => ({ value, prediction: fitted.oneStepAhead[index] ?? 0, index }))
    .filter(({ index }) => index >= fitted.warmup)
    .map(({ value, prediction }) => value - prediction);

/** Named parameters, ready to travel with the forecast. */
export const methodParameters = (fitted: FittedSeries): readonly ForecastFeature[] =>
  fitted.parameters;
