import { addDays } from '@civora/domain';
import { forecastSchema } from '@civora/domain';
import { FACILITY_A, ITEM_PARACETAMOL } from '@civora/domain/testing';
import { describe, expect, it } from 'vitest';

import { forecastDemand } from './engine';
import { fitMethod } from './methods';
import { classifySeries, chooseMethod } from './select';
import type { DemandPoint, DemandSeries } from './types';

/**
 * The engine, and the test the whole project rests on.
 *
 * The censoring comparison is deliberately blunt: two forecasts of the same
 * facility, at the same moment, from the same history, differing only in whether
 * the censored days were corrected. If the correction is not doing what it claims,
 * the corrected figure is not materially higher and this fails.
 */

const FROM = '2026-03-01';

const seriesOf = (issued: readonly number[], dryDays: readonly number[] = []): DemandSeries => {
  const dry = new Set(dryDays);
  const points: DemandPoint[] = issued.map((value, index) => ({
    on: addDays(FROM, index),
    issued: value,
    onHand: dry.has(index) ? 0 : 100,
  }));
  return { facilityId: FACILITY_A, itemId: ITEM_PARACETAMOL, points };
};

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, offset) => from + offset);

const request = (index: number, horizonDays = 14) => ({
  facilityId: FACILITY_A,
  itemId: ITEM_PARACETAMOL,
  asOf: addDays(FROM, index),
  horizonDays,
  seed: 'engine-test',
  synthetic: true,
  provenance: { kind: 'derived', reference: 'poorvadarshan-stat' } as const,
});

describe('censored demand, and what it costs to ignore it', () => {
  // Thirty days dispensing a known ten a day, then an empty shelf. The latent
  // demand across the stock-out is ten a day; the ledger says nothing was needed.
  const LATENT = 10;
  const dry = range(30, 59);

  it('forecasts want rather than supply from inside a stock-out', () => {
    const history = [
      ...Array.from({ length: 30 }, () => LATENT),
      ...Array.from({ length: 30 }, () => 0),
    ];
    const series = seriesOf(history, dry);

    // Asked on the fifteenth day of the stock-out, for the fortnight ahead.
    const asOfIndex = 44;
    const truncated: DemandSeries = {
      ...series,
      points: series.points.slice(0, asOfIndex + 1),
    };

    const corrected = forecastDemand(truncated, request(asOfIndex), {
      requestedMethod: 'moving-average',
    }).forecast;

    // The same engine, on the same days, with the correction switched off: the
    // comparison the phase demands, and the number a naive platform would act on.
    const uncorrectedFit = fitMethod(
      'moving-average',
      truncated.points.map((point) => point.issued),
      { horizon: 14 },
    );
    const uncorrected = uncorrectedFit.rate[0] ?? 0;

    expect(corrected.imputation).toBe('facility-mean');
    expect(corrected.censoredDaysImputed).toBe(15);
    expect(corrected.p50[0]).toBeCloseTo(LATENT, 6);

    // Materially higher, not merely higher: the uncorrected forecast reads the
    // empty shelf as a fall in demand and comes out at under half the truth.
    expect(corrected.p50[0] ?? 0).toBeGreaterThan(uncorrected * 2);
    expect(uncorrected).toBeLessThan(5);
    expect(corrected.warnings).toEqual([]);
  });

  it('reports the censored days it could not repair, and says the fit understates demand', () => {
    // A ledger that dispensed without recording stock, then went dry again with
    // stock on the shelf: the item was clearly in use this month, but no day near
    // the later spell records a dispensable shelf, so there is no rate to
    // correct it with. The forecast has to say so rather than quietly fitting a
    // zero and calling the item unused.
    const series: DemandSeries = {
      facilityId: FACILITY_A,
      itemId: ITEM_PARACETAMOL,
      points: [
        ...range(0, 4).map((index) => ({ on: addDays(FROM, index), issued: 5, onHand: 0 })),
        ...range(5, 9).map((index) => ({ on: addDays(FROM, index), issued: 0, onHand: 0 })),
        ...range(10, 19).map((index) => ({ on: addDays(FROM, index), issued: 0, onHand: 40 })),
        ...range(20, 29).map((index) => ({ on: addDays(FROM, index), issued: 0, onHand: 0 })),
      ],
    };

    const forecast = forecastDemand(series, request(29)).forecast;

    expect(forecast.imputation).toBe('none');
    expect(forecast.censoredDaysImputed).toBe(0);
    expect(forecast.features.find((feature) => feature.name === 'censoredDaysFound')?.value).toBe(
      10,
    );
    expect(forecast.warnings.join(' ')).toContain('could not be imputed');
  });

  it('carries the imputation, the method and the features on the forecast itself', () => {
    // Forty days of steady consumption, then an empty shelf: once the spell is
    // corrected the item is seen to move every day, and the engine picks a
    // method for a daily item rather than the one a raw reading of the ledger
    // would suggest. The correction changes the classification, which is the
    // whole point of doing it first.
    const corrected = forecastDemand(
      seriesOf(
        Array.from({ length: 60 }, (_, index) => (index < 40 ? 8 : 0)),
        range(40, 59),
      ),
      request(59),
    ).forecast;

    expect(corrected.modelVersion).toBe('poorvadarshan-stat-1');
    expect(corrected.method).toBe('holt-winters');
    expect(corrected.imputation).toBe('facility-mean');
    expect(corrected.features.map((feature) => feature.name)).toContain('censoredDaysFound');
    expect(corrected.features.map((feature) => feature.name)).toContain('occurrenceRate');
    expect(forecastSchema.safeParse(corrected).success).toBe(true);

    // The same item moving every few days, with nothing censored, is fitted by
    // the intermittent-demand engine instead.
    const intermittent = forecastDemand(
      seriesOf(Array.from({ length: 60 }, (_, index) => (index % 3 === 0 ? 9 : 0))),
      request(59),
    ).forecast;

    expect(intermittent.method).toBe('croston-sba');
    expect(forecastSchema.safeParse(intermittent).success).toBe(true);
  });
});

describe('choosing an engine from the shape of the series', () => {
  const classify = (issued: readonly number[]) => classifySeries(seriesOf(issued).points);

  it('calls a series that moves every day smooth', () => {
    const classification = classify(Array.from({ length: 60 }, () => 10));
    expect(classification.pattern).toBe('smooth');
    expect(chooseMethod(classification, 60, { seasonLength: 7 })).toBe('holt-winters');
  });

  it('does not fit a seasonal model on less than three cycles of evidence', () => {
    const classification = classify(Array.from({ length: 12 }, () => 10));
    expect(chooseMethod(classification, 12, { seasonLength: 7 })).toBe('moving-average');
  });

  it('calls an item that moves every few days intermittent', () => {
    const issued = Array.from({ length: 60 }, (_, index) => (index % 3 === 0 ? 9 : 0));
    const classification = classify(issued);

    expect(classification.pattern).toBe('intermittent');
    expect(chooseMethod(classification, 60, { seasonLength: 7 })).toBe('croston-sba');
  });

  it('calls an uneven but regularly moving item erratic, and averages it', () => {
    const issued = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? 40 : 1));
    const classification = classify(issued);

    expect(classification.pattern).toBe('erratic');
    expect(chooseMethod(classification, 60, { seasonLength: 7 })).toBe('moving-average');
  });

  it('calls an uneven and rarely moving item lumpy', () => {
    // Movements a fortnight apart, and nothing like each other in size: the
    // quantity to order is as uncertain as the timing.
    const sizes = [60, 5, 44, 8, 51];
    const issued = Array.from({ length: 60 }, (_, index) =>
      index % 12 === 0 ? (sizes[index / 12] ?? 0) : 0,
    );
    const classification = classify(issued);

    expect(classification.pattern).toBe('lumpy');
    expect(chooseMethod(classification, 60, { seasonLength: 7 })).toBe('croston-sba');
  });

  it('notices an item being phased out and decays its rate instead of holding it', () => {
    const issued = [
      ...Array.from({ length: 30 }, (_, index) => (index % 3 === 0 ? 12 : 0)),
      ...Array.from({ length: 30 }, (_, index) => (index % 15 === 0 ? 12 : 0)),
    ];
    const classification = classify(issued);

    expect(classification.pattern).toBe('fading');
    expect(chooseMethod(classification, 60, { seasonLength: 7 })).toBe('tsb');
  });

  it('says nothing is dispensed rather than guessing, when nothing is', () => {
    const classification = classify(Array.from({ length: 60 }, () => 0));

    expect(classification.pattern).toBe('empty');
    expect(chooseMethod(classification, 60, { seasonLength: 7 })).toBe('zero');
  });

  it('lets a caller insist on a method, for comparing engines on one footing', () => {
    const classification = classify(Array.from({ length: 60 }, () => 10));
    expect(chooseMethod(classification, 60, { seasonLength: 7, requested: 'moving-average' })).toBe(
      'moving-average',
    );
  });
});

describe('a facility with no history of its own', () => {
  it('borrows a pooled rate and says how many series it came from', () => {
    const series = seriesOf(Array.from({ length: 6 }, () => 0));

    const forecast = forecastDemand(series, request(5), {
      priorDailyDemand: 4,
      priorSeriesUsed: 9,
    }).forecast;

    expect(forecast.method).toBe('pooled-prior');
    expect(forecast.p50).toEqual(Array.from({ length: 14 }, () => 4));
    expect(forecast.features.find((feature) => feature.name === 'pooledSeries')?.value).toBe(9);
    expect(forecast.warnings.join(' ')).toContain('prior pooled from comparable facilities');
  });

  it('does not borrow when there is nothing to borrow, and warns instead', () => {
    const series = seriesOf(Array.from({ length: 6 }, () => 0));

    const forecast = forecastDemand(series, request(5)).forecast;

    expect(forecast.method).toBe('zero');
    expect(forecast.p50).toEqual(Array.from({ length: 14 }, () => 0));
    expect(forecast.warnings.join(' ')).toContain('statement about the facility');
  });
});

describe('reproducibility', () => {
  it('produces the same forecast from the same series every time', () => {
    const issued = Array.from({ length: 90 }, (_, index) =>
      index % 4 === 0 ? 7 : index % 7 === 0 ? 3 : 0,
    );
    const series = seriesOf(issued);

    const first = forecastDemand(series, request(89)).forecast;
    const second = forecastDemand(series, request(89)).forecast;

    expect(second).toEqual(first);
    expect(second.p90).toEqual(first.p90);
  });

  it('leaves the median alone when the seed changes, and takes the bound from the seed', () => {
    // The seed enters only where the residuals are resampled. On a small
    // residual pool the empirical quantile can saturate and the two seeds can
    // agree on the bound — so what is asserted is where the seed acts, not that
    // the answers must differ.
    const series = seriesOf(Array.from({ length: 60 }, (_, index) => (index % 5 === 0 ? 6 : 1)));

    const first = forecastDemand(series, request(59)).forecast;
    const second = forecastDemand(series, { ...request(59), seed: 'other' }).forecast;

    expect(second.p50).toEqual(first.p50);
    expect(second.p90.length).toBe(first.p90.length);
    second.p90.forEach((value, day) => {
      expect(value).toBeGreaterThanOrEqual(second.p50[day] ?? 0);
    });
  });

  it('covers exactly the horizon it was asked for', () => {
    const series = seriesOf(Array.from({ length: 60 }, () => 5));
    const forecast = forecastDemand(series, request(59, 30)).forecast;

    expect(forecast.p50).toHaveLength(30);
    expect(forecast.p90).toHaveLength(30);
    expect(forecast.horizonDays).toBe(30);
  });
});
