import { FACILITY_A, ITEM_PARACETAMOL } from '@civora/domain/testing';
import { addDays } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { imputeCensoredDemand } from './impute';
import type { DemandPoint, DemandSeries } from './types';

/**
 * Correcting censored days.
 *
 * The rules here decide whether a forecast sees need or supply, so they are
 * asserted directly rather than through the engine that calls them. The cases
 * that matter are the ones where the correction cannot be made: an imputation
 * that quietly leaves a zero where it could not estimate anything is how a
 * stock-out becomes an argument for ordering less.
 */

const FROM = '2026-03-01';

/** A series from issued quantities, with the shelf empty on the given days. */
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

/** Thirty days dispensing ten a day, thirty dry, then twenty more. */
const drySpell = range(30, 59);

describe('imputing censored demand', () => {
  it('leaves a series with no stock-out alone, and says nothing was corrected', () => {
    const series = seriesOf(Array.from({ length: 60 }, () => 10));
    const imputed = imputeCensoredDemand(series);

    expect(imputed.imputation).toBe('none');
    expect(imputed.censoredDaysFound).toBe(0);
    expect(imputed.censoredDaysImputed).toBe(0);
    expect(imputed.warnings).toEqual([]);
    expect(imputed.points).toEqual(series.points);
  });

  it("replaces a dry spell with the facility's own rate from the days around it", () => {
    const series = seriesOf(
      [...Array.from({ length: 30 }, () => 10), ...Array.from({ length: 30 }, () => 0), 10, 10],
      drySpell,
    );

    const imputed = imputeCensoredDemand(series);

    expect(imputed.imputation).toBe('facility-mean');
    expect(imputed.censoredDaysFound).toBe(30);
    expect(imputed.censoredDaysImputed).toBe(30);
    expect(imputed.latentDailyDemand).toBe(10);
    expect(imputed.warnings).toEqual([]);

    // The dry days now describe what was wanted rather than what was available,
    // and every other day is untouched.
    const corrected = imputed.points.filter((point) => point.issued === 10);
    expect(corrected).toHaveLength(62);
    expect(imputed.points.some((point) => point.issued === 0)).toBe(false);
  });

  /**
   * A ledger that dispensed without recording stock, then went dry again.
   *
   * The first ten days have an empty shelf and five units dispensed anyway — a
   * facility drawing on a batch the ledger never recorded, which the replay
   * reports as a defect rather than hiding. The next ten show stock on the shelf
   * and nothing dispensed. The last ten are the dry spell being examined: the
   * item was clearly in use this month, but no day anywhere near it records a
   * dispensable shelf, so there is no rate to correct it with.
   */
  const incompleteLedger = (): DemandSeries => ({
    facilityId: FACILITY_A,
    itemId: ITEM_PARACETAMOL,
    points: [
      ...range(0, 4).map((index) => ({ on: addDays(FROM, index), issued: 5, onHand: 0 })),
      ...range(5, 9).map((index) => ({ on: addDays(FROM, index), issued: 0, onHand: 0 })),
      ...range(10, 19).map((index) => ({ on: addDays(FROM, index), issued: 0, onHand: 40 })),
      ...range(20, 29).map((index) => ({ on: addDays(FROM, index), issued: 0, onHand: 0 })),
    ],
  });

  it('uses a peer rate when the facility offers no rate of its own, and says so', () => {
    const imputed = imputeCensoredDemand(incompleteLedger(), { peerDailyDemand: 6 });

    expect(imputed.imputation).toBe('peer-mean');
    expect(imputed.latentDailyDemand).toBe(6);
    expect(imputed.censoredDaysImputed).toBe(10);
    expect(imputed.warnings.join(' ')).toContain('comparable facilities');
  });

  it('reports a censored spell it could not correct rather than imputing a zero', () => {
    const imputed = imputeCensoredDemand(incompleteLedger());

    expect(imputed.imputation).toBe('none');
    expect(imputed.censoredDaysFound).toBe(10);
    expect(imputed.censoredDaysImputed).toBe(0);
    expect(imputed.warnings.join(' ')).toContain('could not be imputed');
    expect(imputed.points).toEqual(incompleteLedger().points);
  });

  it('does not treat an item the facility simply does not stock as censored', () => {
    // Zero on hand forever and never dispensed: there is no evidence the item was
    // wanted, so correcting it would invent demand for something nobody uses.
    const series = seriesOf(
      Array.from({ length: 60 }, () => 0),
      range(0, 59),
    );

    const imputed = imputeCensoredDemand(series);

    expect(imputed.censoredDaysFound).toBe(0);
    expect(imputed.censoredDaysImputed).toBe(0);
    expect(imputed.imputation).toBe('none');
  });

  it('corrects only the dry days, and reports the rate it used', () => {
    const imputed = imputeCensoredDemand(seriesOf([12, 12, 12, 0, 0, 12, 12], [3, 4]));

    expect(imputed.imputation).toBe('facility-mean');
    expect(imputed.censoredDaysImputed).toBe(2);
    expect(imputed.latentDailyDemand).toBe(12);
    expect(imputed.points.map((point) => point.issued)).toEqual([12, 12, 12, 12, 12, 12, 12]);
  });
});
