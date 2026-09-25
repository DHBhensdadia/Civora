import { describe, expect, it } from 'vitest';

import { addDays } from './dates';
import { countCensoredDays, detectCensoredIntervals } from './censoring';
import { daysOfStock, demandRateFromLedger, observedDailyIssues } from './inventory';
import type { LedgerDay } from './ledger';

/**
 * Censored demand is the failure this platform exists to remove, so both halves
 * of the mechanism are asserted: that a dry spell with the item in use is
 * detected, and that a dry spell without it is not. The second case matters as
 * much as the first — a facility that simply does not keep an item sits at zero
 * on-hand forever, and calling that a stock-out would fill the platform with
 * phantom shortages.
 */

const series = (
  onHand: readonly number[],
  issued: readonly number[],
  from = '2026-01-01',
): LedgerDay[] =>
  onHand.map((level, offset) => ({
    on: addDays(from, offset),
    onHand: level,
    issued: issued[offset] ?? 0,
  }));

/** Six days of use, then a three-day dry spell, then use again. */
const DRIED_OUT_THEN_RESUPPLIED = series(
  [50, 40, 30, 0, 0, 0, 30, 20, 10, 5],
  [5, 5, 5, 0, 0, 0, 5, 5, 5, 5],
);

describe('detecting censored demand', () => {
  it('finds a dry spell surrounded by use of the same item', () => {
    const intervals = detectCensoredIntervals(DRIED_OUT_THEN_RESUPPLIED);

    expect(intervals).toHaveLength(1);
    expect(intervals.at(0)?.from).toBe('2026-01-04');
    expect(intervals.at(0)?.to).toBe('2026-01-06');
    expect(intervals.at(0)?.days).toBe(3);
    expect(countCensoredDays(intervals)).toBe(3);
  });

  it('estimates latent demand from the days the facility could dispense', () => {
    const intervals = detectCensoredIntervals(DRIED_OUT_THEN_RESUPPLIED);

    // Under-reporting the estimate would under-order; the number has to come
    // from days that were not censored.
    expect(intervals.at(0)?.estimatedDailyDemand).toBe(5);
  });

  it('does not report a stock-out for an item the facility simply does not keep', () => {
    const dormant = series([0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]);

    expect(detectCensoredIntervals(dormant)).toEqual([]);
  });

  it('does not report a dry spell for an item that was never in use around it', () => {
    const heldButUnused = series([50, 50, 0, 0, 0, 50], [0, 0, 0, 0, 0, 0]);

    expect(detectCensoredIntervals(heldButUnused)).toEqual([]);
  });

  it('detects a single dry day', () => {
    const oneDay = series([50, 40, 0, 40, 30], [5, 5, 0, 5, 5]);

    const intervals = detectCensoredIntervals(oneDay);
    expect(intervals.at(0)?.days).toBe(1);
    expect(intervals.at(0)?.estimatedDailyDemand).toBe(5);
  });

  it('treats stock below a dispensing floor as unavailable, not just stock at zero', () => {
    // A facility that keeps a reserve will not hand out its last few units, so
    // an empty shelf is not the only way to be unable to dispense.
    const buffered = series([50, 40, 0, 40, 30], [5, 5, 0, 5, 5]);

    const atZero = detectCensoredIntervals(buffered, { minimumDispenseLevel: 0 });
    expect(atZero).toHaveLength(1);
    expect(atZero.at(0)?.days).toBe(1);

    const atFloor = detectCensoredIntervals(buffered, { minimumDispenseLevel: 45 });
    expect(atFloor).toHaveLength(1);
    expect(atFloor.at(0)?.from).toBe('2026-01-02');
    expect(atFloor.at(0)?.to).toBe('2026-01-05');
  });
});

describe('correcting for it', () => {
  it('uses the recorded rate when nothing was censored', () => {
    const neverDry = series([50, 45, 40, 35], [5, 5, 5, 0]);

    const demand = demandRateFromLedger(neverDry);
    expect(demand.basis).toBe('observed');
    expect(demand.rate).toBe(3.75);
  });

  it('uses the uncensored days when the facility ran dry', () => {
    const demand = demandRateFromLedger(DRIED_OUT_THEN_RESUPPLIED);

    expect(demand.basis).toBe('censoring-corrected');
    expect(demand.rate).toBe(5);
  });

  it('shows why the correction changes the answer', () => {
    // The recorded rate counts the dry days as days of no need. Reading it that
    // way makes a facility that could not dispense look like one that did not
    // need to, which is how an empty shelf comes to look well covered.
    const recordedRate = observedDailyIssues(DRIED_OUT_THEN_RESUPPLIED);
    const correctedRate = demandRateFromLedger(DRIED_OUT_THEN_RESUPPLIED).rate;
    const onHand = 50;

    expect(recordedRate).toBeLessThan(correctedRate);
    expect(daysOfStock(onHand, recordedRate) ?? 0).toBeGreaterThan(
      daysOfStock(onHand, correctedRate) ?? 0,
    );
  });
});

describe('cover', () => {
  it('reports unmeasurable demand as unknown rather than as a safe quantity', () => {
    expect(daysOfStock(100, 0)).toBeNull();
    expect(daysOfStock(0, 0)).toBeNull();
  });

  it('reports cover as the position divided by the daily rate', () => {
    expect(daysOfStock(50, 5)).toBe(10);
    expect(daysOfStock(0, 5)).toBe(0);
  });
});
