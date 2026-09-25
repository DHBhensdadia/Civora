import { describe, expect, it } from 'vitest';

import { fitMethod, residualsOf } from './methods';

/**
 * The engines, against numbers worked out by hand.
 *
 * Each fixture is small enough that the expected output can be recomputed on
 * paper from the published update rule, which is the only way to tell a filter
 * that is correctly implemented from one that is merely stable. A test that
 * asserted "the forecast is 3.7" because that is what the code returned when it
 * was written would pass forever and prove nothing.
 */

const horizon = 3;

describe('the baselines', () => {
  it('predicts nothing at all when asked for nothing', () => {
    const fitted = fitMethod('zero', [4, 0, 9], { horizon });

    expect(fitted.rate).toEqual([0, 0, 0]);
    expect(fitted.oneStepAhead).toEqual([0, 0, 0]);
  });

  it('averages the recent window for a series consumed every day', () => {
    // Window of two: at index 3 the prediction is the mean of the two days
    // before it, and the forecast is the mean of the last two days.
    const fitted = fitMethod('moving-average', [0, 0, 10, 10], { horizon, window: 2 });

    expect(fitted.oneStepAhead).toEqual([0, 0, 0, 5]);
    expect(fitted.rate).toEqual([10, 10, 10]);
  });

  it('repeats the last cycle, by weekday, for a seasonal series', () => {
    const fitted = fitMethod('seasonal-naive', [1, 2, 3, 4, 10, 20, 30, 40], {
      horizon: 4,
      seasonLength: 4,
    });

    expect(fitted.oneStepAhead).toEqual([0, 0, 0, 0, 1, 2, 3, 4]);
    expect(fitted.rate).toEqual([10, 20, 30, 40]);
  });
});

describe("Croston's method", () => {
  it('prices an isolated movement by its size and the gap before it', () => {
    // With a smoothing constant of one the updates are the observations, so the
    // arithmetic is exact: a movement of 6 arrives three days after the previous
    // one, giving a rate of 6/3 = 2 per day.
    const fitted = fitMethod('croston', [0, 4, 0, 0, 6], { horizon, alpha: 1 });

    expect(fitted.oneStepAhead).toEqual([0, 0, 4, 4, 4]);
    expect(fitted.rate).toEqual([2, 2, 2]);
  });

  it('applies the Syntetos–Boylan correction to remove Croston\u2019s bias', () => {
    const values = [0, 4, 0, 0, 6];
    const plain = fitMethod('croston', values, { horizon, alpha: 1 });
    const corrected = fitMethod('croston-sba', values, { horizon, alpha: 1 });

    // The correction factor is (1 - alpha/2), which for a fully adaptive fit is
    // half the plain estimate: the point is that it is strictly lower.
    expect(corrected.rate[0]).toBeCloseTo((plain.rate[0] ?? 0) * 0.5, 10);
  });

  it('forecasts nothing until it has seen a movement', () => {
    const fitted = fitMethod('croston-sba', [0, 0, 0], { horizon });

    expect(fitted.rate).toEqual([0, 0, 0]);
    expect(fitted.warmup).toBe(3);
  });
});

describe('Teunter–Syntetos–Babai', () => {
  it('decays the probability of use as the silent days accumulate', () => {
    // alpha = beta = 0.5, starting probability 1/3 and size 4: the exact
    // predictions are 4/3, 2/3 and 7/3, and the rate is 7/24 x 4 = 7/6.
    const fitted = fitMethod('tsb', [0, 4, 0], { horizon, alpha: 0.5, beta: 0.5 });

    expect(fitted.oneStepAhead[0]).toBeCloseTo(4 / 3, 10);
    expect(fitted.oneStepAhead[1]).toBeCloseTo(2 / 3, 10);
    expect(fitted.oneStepAhead[2]).toBeCloseTo(7 / 3, 10);
    expect(fitted.rate[0]).toBeCloseTo(7 / 6, 10);
  });

  it('falls to zero for an item that has stopped being used', () => {
    const fitted = fitMethod('tsb', [8, 8, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0], {
      horizon,
      alpha: 0.5,
      beta: 0.5,
    });

    expect(fitted.rate[0]).toBeLessThan(0.5);
  });
});

describe('Holt-Winters', () => {
  it('holds a flat series flat', () => {
    const fitted = fitMethod('holt-winters', [10, 10, 10], { horizon, seasonLength: 1 });

    expect(fitted.oneStepAhead).toEqual([10, 10, 10]);
    expect(fitted.rate).toEqual([10, 10, 10]);
  });

  it('carries a trend forward rather than flattening it', () => {
    const values = Array.from({ length: 28 }, (_, index) => 10 + index);
    const fitted = fitMethod('holt-winters', values, {
      horizon,
      seasonLength: 7,
      alpha: 0.5,
      beta: 0.5,
      gamma: 0.1,
    });

    // Four weeks of an item rising by a unit a day: the forecast has to follow the
    // series to its end rather than report the level it started from, and it has
    // to keep rising across the horizon. It does not claim to exceed the last
    // observation — a filter with a finite smoothing constant lags by construction,
    // and asserting otherwise would be asserting a bug.
    const last = values[values.length - 1] ?? 0;
    const first = fitted.rate[0] ?? 0;

    expect(Math.abs(first - last)).toBeLessThan(Math.abs(first - (values[0] ?? 0)));
    expect(fitted.rate[2]).toBeGreaterThan(first);
  });

  it('gives up on seasonality when it has less than two cycles to learn from', () => {
    // Twelve days against a weekly cycle: one full cycle and a bit. The fit
    // records that it dropped to a trend-only model rather than inventing a
    // seasonal shape from one week.
    const fitted = fitMethod(
      'holt-winters',
      Array.from({ length: 12 }, () => 5),
      {
        horizon,
        seasonLength: 7,
      },
    );

    const season = fitted.parameters.find((parameter) => parameter.name === 'seasonLength');
    expect(season?.value).toBe(1);
  });
});

describe('residuals', () => {
  it('are the differences between what happened and what was predicted', () => {
    const values = [0, 0, 10, 10];
    const fitted = fitMethod('moving-average', values, { horizon, window: 2 });

    // Predictions are 0, 0, 0 and 5; the warm-up of two days is dropped.
    expect(residualsOf(values, fitted)).toEqual([10, 5]);
  });
});
