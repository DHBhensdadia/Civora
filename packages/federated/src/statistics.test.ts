import type { ItemId } from '@civora/domain';
import type { DemandPoint, DemandSeries } from '@civora/forecasting';
import { forecastDemand } from '@civora/forecasting';
import { describe, expect, it } from 'vitest';

import { federatedPriorFor, forecasterPriorFields, statisticsForSilo } from './statistics';

const pointsOf = (days: number, issued: (index: number) => number): readonly DemandPoint[] =>
  Array.from({ length: days }, (_unused, index) => ({
    // Two months, so the seasonal factors have something to see.
    on:
      index < 31
        ? `2026-01-${String(index + 1).padStart(2, '0')}`
        : `2026-02-${String(index - 30).padStart(2, '0')}`,
    issued: issued(index),
    onHand: 200,
  }));

/** Two whole months of equal length, so a month's factor is exactly its ratio. */
const twoMonths = (january: number, february: number): readonly DemandPoint[] => [
  ...Array.from({ length: 30 }, (_unused, index) => ({
    on: `2026-01-${String(index + 1).padStart(2, '0')}`,
    issued: january,
    onHand: 200,
  })),
  ...Array.from({ length: 30 }, (_unused, index) => ({
    on: `2026-02-${String(index + 1).padStart(2, '0')}`,
    issued: february,
    onHand: 200,
  })),
];

const seriesOf = (itemId: string, points: readonly DemandPoint[]): DemandSeries => ({
  facilityId: 'FAC-1' as DemandSeries['facilityId'],
  itemId: itemId as DemandSeries['itemId'],
  points,
});

describe('federated statistics', () => {
  it('shares sums and counts, per item, over the trailing window', () => {
    const statistics = statisticsForSilo({
      siloId: 'SIM-A',
      series: [
        seriesOf(
          'ITEM-A',
          pointsOf(60, () => 4),
        ),
        seriesOf(
          'ITEM-B',
          pointsOf(60, (index) => (index % 2 === 0 ? 2 : 0)),
        ),
      ],
    });

    expect(statistics).toHaveLength(2);
    const itemA = statistics.find((entry) => entry.itemId === 'ITEM-A');
    expect(itemA?.daysObserved).toBe(56);
    expect(itemA?.unitsIssued).toBe(56 * 4);
    expect(itemA?.movingDays).toBe(56);
    expect(itemA?.siloId).toBe('SIM-A');

    const itemB = statistics.find((entry) => entry.itemId === 'ITEM-B');
    expect(itemB?.unitsIssued).toBe(56);
    expect(itemB?.movingDays).toBe(28);
  });

  it('pools across silos, weighted by the days behind each statistic', () => {
    const short = statisticsForSilo({
      siloId: 'SIM-SHORT',
      series: [
        seriesOf(
          'ITEM-A',
          pointsOf(20, () => 1),
        ),
      ],
    });
    const long = statisticsForSilo({
      siloId: 'SIM-LONG',
      series: [
        seriesOf(
          'ITEM-A',
          pointsOf(56, () => 5),
        ),
      ],
    });

    const prior = federatedPriorFor('ITEM-A' as ItemId, [...short, ...long]);
    expect(prior).not.toBeNull();
    expect(prior?.silos).toBe(2);
    expect(prior?.seriesUsed).toBe(2);
    expect(prior?.daysObserved).toBe(76);
    // (20·1 + 56·5) / 76 — the long silo carries more weight because it has more days.
    expect(prior?.dailyDemand).toBeCloseTo((20 * 1 + 56 * 5) / 76, 12);
    expect(prior?.occurrenceRate).toBeCloseTo(1, 12);
  });

  it('reports a seasonal factor per month, against the item’s own annual rate', () => {
    // Two 30-day months, January at 2/day and February at 4/day: annual 3/day,
    // so the factors are 2/3 and 4/3 exactly. The window is stated as the whole
    // 60 days on purpose — the default 56-day window would clip four of them,
    // and a factor is only "this month against the year" if the month is whole.
    // The first test asserts what the default window keeps; this one asserts the
    // arithmetic on whole months.
    const statistics = statisticsForSilo(
      { siloId: 'SIM-A', series: [seriesOf('ITEM-A', twoMonths(2, 4))] },
      { windowDays: 60 },
    );
    const prior = federatedPriorFor('ITEM-A' as ItemId, statistics);
    const january = prior?.seasonalFactors.find((factor) => factor.month === 1);
    const february = prior?.seasonalFactors.find((factor) => factor.month === 2);
    expect(january?.factor).toBeCloseTo(2 / 3, 6);
    expect(february?.factor).toBeCloseTo(4 / 3, 6);
  });

  it('answers nothing for an item no silo ever held', () => {
    expect(federatedPriorFor('ITEM-NONE' as ItemId, [])).toBeNull();
    const statistics = statisticsForSilo({
      siloId: 'SIM-A',
      series: [
        seriesOf(
          'ITEM-A',
          pointsOf(60, () => 1),
        ),
      ],
    });
    expect(federatedPriorFor('ITEM-NONE' as ItemId, statistics)).toBeNull();
  });

  it('feeds the forecaster’s cold-start path — the wiring, not just the shape', () => {
    const statistics = statisticsForSilo({
      siloId: 'SIM-A',
      series: [
        seriesOf(
          'ITEM-A',
          pointsOf(60, () => 5),
        ),
      ],
    });
    const prior = federatedPriorFor('ITEM-A' as ItemId, statistics);
    expect(prior).not.toBeNull();
    if (prior === null) {
      return;
    }

    // A facility that has held the item for ten days only. Without a prior it
    // would be fitted on a fortnight of noise; with one it uses the pool.
    const cold: DemandSeries = {
      facilityId: 'FAC-COLD' as DemandSeries['facilityId'],
      itemId: 'ITEM-A' as DemandSeries['itemId'],
      points: pointsOf(10, (index) => (index % 3 === 0 ? 2 : 0)),
    };

    const outcome = forecastDemand(
      cold,
      {
        facilityId: cold.facilityId,
        itemId: cold.itemId,
        asOf: '2026-02-10',
        horizonDays: 14,
        seed: 'federated-prior-test',
        synthetic: true,
        provenance: { kind: 'derived', reference: 'federated-statistics' },
      },
      { ...forecasterPriorFields(prior), minimumHistoryDays: 14 },
    );

    expect(outcome.forecast.method).toBe('pooled-prior');
    const carried = outcome.forecast.features.find(
      (feature) => feature.name === 'pooledDailyDemand',
    );
    expect(carried?.value).toBeCloseTo(prior.dailyDemand, 12);
    expect(
      outcome.forecast.features.find((feature) => feature.name === 'pooledSeries')?.value,
    ).toBe(prior.seriesUsed);
    expect(outcome.forecast.warnings.some((warning) => warning.includes('prior pooled'))).toBe(
      true,
    );
  });
});
