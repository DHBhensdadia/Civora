import { FACILITY_A, ITEM_PARACETAMOL } from '@civora/domain/testing';
import { addDays } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { BACKTEST_COVERAGE_TOLERANCE_GUARD, runBacktest } from './backtest';
import type { BacktestSeries } from './backtest';
import { forecastDemand } from './engine';
import type { DemandPoint, DemandSeries, ForecastRequest } from './types';

/**
 * The phase's blocking test, and the calibration contract.
 *
 * This file exists on its own so that the one comparison the whole project
 * rests on is not a paragraph inside another file's test. The claim is narrow
 * and checkable: a model fitted on a history that contains a stock-out
 * under-orders after it, and correcting the censored days removes that
 * under-ordering. Both forecasts are run on the same series, from the same
 * origin, choosing the same method — the *only* difference is whether the dry
 * days were repaired before the fit.
 */

const FROM = '2026-01-01';

const RATE = 10;
const OPENING_DAYS = 40;
const DRY_DAYS = 30;
const RECOVERY_DAYS = 20;

/**
 * Forty days dispensing ten a day, thirty dry, then twenty more.
 *
 * The latent demand across all ninety days is ten a day. The dry spell dispensed
 * nothing because the shelf was empty, which is exactly the situation a model
 * fitted on recorded issues cannot tell apart from an item falling out of use.
 */
const gappySeries = (): DemandSeries => {
  const issued = [
    ...Array.from({ length: OPENING_DAYS }, () => RATE),
    ...Array.from({ length: DRY_DAYS }, () => 0),
    ...Array.from({ length: RECOVERY_DAYS }, () => RATE),
  ];

  return {
    facilityId: FACILITY_A,
    itemId: ITEM_PARACETAMOL,
    points: issued.map((value, index): DemandPoint => ({
      on: addDays(FROM, index),
      issued: value,
      // The shelf is empty for the whole dry spell, which is what makes the
      // censoring detectable at all rather than a mysteriously quiet fortnight.
      onHand: index >= OPENING_DAYS && index < OPENING_DAYS + DRY_DAYS ? 0 : 500,
    })),
  };
};

const series = gappySeries();

/** An origin inside the dry spell, with the horizon covering the rest of it. */
const ORIGIN = OPENING_DAYS + 15;
const HORIZON = DRY_DAYS - 16 + RECOVERY_DAYS;

const request: ForecastRequest = {
  facilityId: FACILITY_A,
  itemId: ITEM_PARACETAMOL,
  asOf: addDays(FROM, ORIGIN),
  horizonDays: HORIZON,
  seed: 'censoring-blocking-test',
  synthetic: true,
  provenance: { kind: 'derived', reference: 'censoring-test' },
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

describe('a forecast fitted across a stock-out', () => {
  // The same method is requested on both sides, so the comparison is about the
  // correction and not about the classifier noticing the zeros and switching
  // engines. An unfair comparison here would be the easiest way to make the
  // correction look better than it is.
  const options = { requestedMethod: 'croston-sba' } as const;

  const corrected = forecastDemand(series, request, options);
  const uncorrected = forecastDemand(series, request, { ...options, imputation: 'none' });

  it('does not read the censored days as a fall in demand', () => {
    // The correction found the dry spell, repaired it, and said what it used.
    expect(corrected.forecast.censoredDaysImputed).toBe(DRY_DAYS);
    expect(corrected.forecast.imputation).toBe('facility-mean');
    expect(corrected.forecast.warnings).toEqual([]);

    // And the uncorrected fit took the zeros at face value, which is the failure
    // the correction exists to remove.
    expect(uncorrected.forecast.censoredDaysImputed).toBe(0);
    expect(uncorrected.forecast.imputation).toBe('none');
  });

  it('forecasts materially more demand than the same model fitted without correction', () => {
    const correctedMean = mean(corrected.forecast.p50);
    const uncorrectedMean = mean(uncorrected.forecast.p50);

    // Both numbers are asserted rather than only the comparison, because "the
    // correction helped" is not evidence unless the reader can see what it moved
    // from and to.
    expect(correctedMean).toBeGreaterThan(RATE * 0.9);
    expect(uncorrectedMean).toBeLessThan(RATE * 0.85);
    expect(correctedMean - uncorrectedMean).toBeGreaterThan(2);

    // Stated as a share as well, so the size of the effect travels with the
    // claim wherever it is quoted.
    const improvement = (correctedMean - uncorrectedMean) / uncorrectedMean;
    expect(improvement).toBeGreaterThan(0.2);
  });

  it('is closer to what was actually wanted, which is the only thing that matters', () => {
    const latent = RATE;
    const correctedError = Math.abs(mean(corrected.forecast.p50) - latent);
    const uncorrectedError = Math.abs(mean(uncorrected.forecast.p50) - latent);

    expect(correctedError).toBeLessThan(uncorrectedError);
  });

  it('carries the correction it made, so the number can be audited later', () => {
    const features = new Map(
      corrected.forecast.features.map((feature) => [feature.name, feature.value]),
    );

    expect(features.get('censoredDaysFound')).toBe(DRY_DAYS);
    expect(features.get('imputedDailyDemand')).toBe(RATE);
    expect(corrected.forecast.method).toBe('croston-sba');
  });
});

describe('the calibration summary the report publishes', () => {
  const entries: BacktestSeries[] = Array.from({ length: 4 }, (_, index) => {
    const points = Array.from({ length: 120 }, (_, day): DemandPoint => ({
      on: addDays(FROM, day),
      issued: 8 + index + (day % 7),
      onHand: 400,
    }));
    const backed: DemandSeries = {
      facilityId: FACILITY_A,
      itemId: ITEM_PARACETAMOL,
      points,
    };
    return { series: backed, latent: points.map((point) => point.issued) };
  });

  const report = runBacktest(entries, {
    horizonDays: 7,
    strideDays: 14,
    baselines: ['zero', 'moving-average', 'seasonal-naive', 'croston'],
    minimumHistoryDays: 28,
    maxOriginsPerSeries: 3,
    bootstrapReplications: 60,
    seasonLength: 7,
    coverageLevel: 0.9,
    coverageTolerance: BACKTEST_COVERAGE_TOLERANCE_GUARD,
  });

  it('reports achieved coverage on both targets against the nominal quantile', () => {
    expect(report.calibration.nominal).toBe(0.9);
    expect(report.calibration.days).toBeGreaterThan(0);
    expect(report.calibration.achievedRecorded).toBeGreaterThanOrEqual(0);
    expect(report.calibration.achievedRecorded).toBeLessThanOrEqual(1);
    expect(report.calibration.achievedLatent).toBeGreaterThanOrEqual(0);
    expect(report.calibration.achievedLatent).toBeLessThanOrEqual(1);
  });

  it('actually applies the tolerance it was given, in both directions', () => {
    // The flag has to be a comparison and not a constant. A tolerance narrower
    // than the achieved gap must fail it, or the report's pass is decoration.
    const strict = runBacktest(entries, {
      horizonDays: 7,
      strideDays: 14,
      baselines: ['zero'],
      minimumHistoryDays: 28,
      maxOriginsPerSeries: 2,
      bootstrapReplications: 40,
      seasonLength: 7,
      coverageLevel: 0.9,
      coverageTolerance: 0,
    });

    expect(strict.calibration.withinToleranceRecorded).toBe(
      strict.calibration.achievedRecorded === 0.9,
    );
    expect(strict.calibration.withinToleranceLatent).toBe(
      strict.calibration.achievedLatent === 0.9,
    );
  });

  it('reports the censoring comparison on the populations it was asked about', () => {
    // Every origin here has stock, so the affected and horizon populations are
    // empty and the report says so rather than reporting a zero as a result.
    expect(report.censoring.all.forecastDays).toBeGreaterThan(0);
    expect(report.censoring.affected.forecastDays).toBe(0);
    expect(report.censoring.horizon.forecastDays).toBe(0);
    expect(report.censoring.censoredDays).toBe(0);
  });

  it('ranks every baseline it was given, so a baseline that wins is visible', () => {
    expect(report.scores.map((score) => score.method).sort()).toEqual(
      ['croston', 'engine', 'moving-average', 'seasonal-naive', 'zero'].sort(),
    );
    // Sorted worst-to-best by a scale-free error, so the first row is the method
    // a reader should believe least.
    for (let index = 1; index < report.scores.length; index += 1) {
      expect(report.scores[index]?.mase ?? 0).toBeGreaterThanOrEqual(
        report.scores[index - 1]?.mase ?? 0,
      );
    }
  });
});
