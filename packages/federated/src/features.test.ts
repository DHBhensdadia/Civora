import type { DemandPoint, DemandSeries } from '@civora/forecasting';
import { seriesFeatures } from '@civora/forecasting';
import { describe, expect, it } from 'vitest';

import {
  DERIVED_FEATURE_NAMES,
  FEDERATED_FEATURE_NAMES,
  SERIES_FEATURE_NAMES,
  buildSiloSamples,
} from './features';

const day = (index: number): string => `2026-01-${String(index + 1).padStart(2, '0')}`;

const seriesOf = (points: readonly DemandPoint[]): DemandSeries => ({
  facilityId: 'FAC-1' as DemandSeries['facilityId'],
  itemId: 'ITEM-1' as DemandSeries['itemId'],
  points,
});

const steady = (days: number, issued = 4, onHand = 100): readonly DemandPoint[] =>
  Array.from({ length: days }, (_unused, index) => ({
    on: day(index),
    issued,
    onHand,
  }));

describe('the federated feature schema', () => {
  it("takes its series block from the forecaster's own name list", () => {
    // The names are read off the function, not restated beside it; this test
    // fails the moment the two diverge.
    expect(SERIES_FEATURE_NAMES).toEqual(seriesFeatures([]).map((feature) => feature.name));
    expect(FEDERATED_FEATURE_NAMES).toEqual([
      ...seriesFeatures([]).map((feature) => feature.name),
      ...DERIVED_FEATURE_NAMES,
    ]);
  });

  it('builds rows whose series block is exactly a seriesFeatures call', () => {
    const built = buildSiloSamples([seriesOf(steady(40))], { minHistoryDays: 28 });
    expect(built.featureNames).toHaveLength(FEDERATED_FEATURE_NAMES.length);
    expect(built.samples.length).toBeGreaterThan(0);
    const first = built.samples[0];
    expect(first?.features).toHaveLength(FEDERATED_FEATURE_NAMES.length);

    const points = steady(40);
    const expectedBlock = seriesFeatures(points.slice(0, 28)).map((feature) => feature.value);
    expect(first?.features.slice(0, expectedBlock.length)).toEqual(expectedBlock);
  });

  it('corrects censored days before they become targets', () => {
    const points: DemandPoint[] = [
      ...steady(10, 6, 100),
      ...Array.from({ length: 5 }, (_unused, index) => ({
        on: day(10 + index),
        issued: 0,
        onHand: 0,
      })),
      ...steady(25, 6, 100).map((point, index) => ({ ...point, on: day(15 + index) })),
    ];
    const built = buildSiloSamples([seriesOf(points)], { minHistoryDays: 28 });
    expect(built.censoredDaysFound).toBe(5);
    expect(built.censoredDaysImputed).toBe(5);
    expect(built.imputation).toBe('facility-mean');

    // The censored stretch sits inside the 28-day rolling window of the first
    // row, so the correction is visible where it matters: a builder that read
    // the raw zeros would roll a calmer history into every later row. The
    // corrected rolling mean is 6; the uncorrected one is 23·6/28 ≈ 4.93.
    const rolling28 = built.samples[0]?.features[SERIES_FEATURE_NAMES.length + 4];
    expect(rolling28).toBeCloseTo(6, 6);
    expect(rolling28 ?? 0).toBeGreaterThan(5.9);
  });

  it('leaks nothing from the day being predicted', () => {
    const days = 40;
    const first = buildSiloSamples([seriesOf(steady(days))], { minHistoryDays: 28 });
    const changed: DemandPoint[] = steady(days).map((point, index) =>
      index === days - 1 ? { ...point, issued: 99 } : point,
    );
    const second = buildSiloSamples([seriesOf(changed)], { minHistoryDays: 28 });

    // Every row that predicts a day before the changed one must be identical;
    // only the last row's target may move.
    expect(first.samples.length).toBe(second.samples.length);
    for (let index = 0; index < first.samples.length - 1; index += 1) {
      expect(second.samples[index]?.features).toEqual(first.samples[index]?.features);
      expect(second.samples[index]?.target).toBe(first.samples[index]?.target);
    }
    expect(second.samples.at(-1)?.target).toBe(99);
  });

  it('reports short series rather than inventing rows for them', () => {
    const built = buildSiloSamples([seriesOf(steady(10)), seriesOf(steady(40))], {
      minHistoryDays: 28,
    });
    expect(built.shortSeries).toBe(1);
    expect(built.seriesCount).toBe(1);
    expect(built.samples.length).toBeGreaterThan(0);
  });
});
