import { describe, expect, it } from 'vitest';

import { bootstrapQuantiles } from './quantiles';
import { createSampler } from './randomness';

/**
 * The upper bound, and whether it means anything.
 *
 * An interval is only worth showing an officer if it covers what it claims to.
 * These tests measure that rather than assuming it — the achieved coverage of
 * the p90 over fresh data is asserted against the nominal level — and they show
 * the mechanism widening when the fit is wrong in a consistent direction, which
 * is the case that decides whether a facility in the middle of a surge is warned
 * in time.
 */

const OPTIONS = { replications: 400, level: 0.9, seed: 'test-seed' };

const rate = (days: number, value: number): number[] => Array.from({ length: days }, () => value);

describe('bootstrapping the upper bound', () => {
  it('never falls below the median it was built from', () => {
    const bounds = bootstrapQuantiles([5, 0, 12], [-3, 4, 0, 7, -1], OPTIONS);

    expect(bounds.daily).toHaveLength(3);
    bounds.daily.forEach((value, day) => {
      expect(value).toBeGreaterThanOrEqual([5, 0, 12][day] ?? 0);
    });
    // The accumulated bound is monotone: demand through a fortnight is at least
    // demand through the week before it.
    expect(bounds.cumulative[1]).toBeGreaterThanOrEqual(bounds.cumulative[0] ?? 0);
    expect(bounds.cumulative[2]).toBeGreaterThanOrEqual(bounds.cumulative[1] ?? 0);
  });

  it('is reproducible from its seed alone', () => {
    const values = rate(14, 8);
    const residuals = [-4, -2, -1, 0, 1, 3, 9, -6, 2, 5];

    expect(bootstrapQuantiles(values, residuals, OPTIONS)).toEqual(
      bootstrapQuantiles(values, residuals, OPTIONS),
    );
    expect(bootstrapQuantiles(values, residuals, { ...OPTIONS, seed: 'another' })).not.toEqual(
      bootstrapQuantiles(values, residuals, OPTIONS),
    );
  });

  it('claims no interval at all when there is no evidence about its error', () => {
    const bounds = bootstrapQuantiles([3, 3, 3], [1, -1], OPTIONS);

    expect(bounds.daily).toEqual([3, 3, 3]);
    expect(bounds.cumulative).toEqual([3, 6, 9]);
  });

  it('covers about nine tenths of what actually happened', () => {
    // Residuals from a known distribution: a rate of 20 with noise uniform on
    // [-5, 5), drawn from the same generator the bootstrap uses so the test is
    // reproducible rather than lucky.
    const sampler = createSampler('calibration-noise');
    const residuals = Array.from({ length: 300 }, () => (sampler.index(10_000) / 10_000) * 10 - 5);

    const bounds = bootstrapQuantiles(rate(1, 20), residuals, OPTIONS);
    const limit = bounds.daily[0] ?? 0;

    const freshSampler = createSampler('calibration-fresh');
    const actuals = Array.from(
      { length: 2_000 },
      () => 20 + (freshSampler.index(10_000) / 10_000) * 10 - 5,
    );
    const covered = actuals.filter((value) => value <= limit).length / actuals.length;

    // Nominal is 0.90. The tolerance is wide because the sample is finite — but
    // narrow enough to fail a Gaussian shortcut, or an interval that ignored the
    // residuals altogether and returned the point forecast.
    expect(covered).toBeGreaterThan(0.82);
    expect(covered).toBeLessThan(0.97);
  });

  it('accumulates wider when the fit has been wrong in the same direction for days', () => {
    // The same residual values in the same proportions, differing only in their
    // order: one set alternates, the other comes in runs. A facility whose
    // consumption has stepped up produces the second, and the risk of
    // accumulating a fortnight of it is what the cumulative bound has to catch.
    const pooled = [-5, -5, -4, -4, -3, 5, 5, 5, 4, 3];
    const alternating = [-5, 5, -5, 5, -4, 4, -4, 3, -3, 5];

    const run = bootstrapQuantiles(rate(14, 20), pooled, OPTIONS);
    const calm = bootstrapQuantiles(rate(14, 20), alternating, OPTIONS);

    const runTotal = (run.cumulative[13] ?? 0) - 20 * 14;
    const calmTotal = (calm.cumulative[13] ?? 0) - 20 * 14;

    expect(runTotal).toBeGreaterThan(calmTotal);
    expect(runTotal).toBeGreaterThan(0);
  });
});
