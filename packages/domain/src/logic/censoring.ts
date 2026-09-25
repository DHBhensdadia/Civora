import type { DateOnly } from '../model/common';
import type { LedgerDay } from './ledger';

/**
 * Detecting censored demand.
 *
 * When a facility is out of stock, recorded issues fall to zero — not because
 * nobody needed the medicine, but because there was none to dispense. A model
 * fitted on those numbers learns that stock-outs are periods of low demand, and
 * then under-orders during exactly the shortages it was built to prevent.
 *
 * This module finds those periods in the ledger so that whoever fits the model
 * can correct for them first. It is deliberately separate from the fitting:
 * detection is a statement about the data, correction is a modelling choice,
 * and conflating them makes both impossible to audit.
 */

export interface CensoringOptions {
  /**
   * On-hand at or below this level counts as unable to dispense. Defaults to
   * zero; a facility keeping a reserve buffer may set it higher.
   */
  readonly minimumDispenseLevel?: number;
  /**
   * How far either side of a dry spell to look for evidence that the item was
   * still in use. Defaults to 30 days.
   */
  readonly activityWindowDays?: number;
}

export interface CensoredInterval {
  readonly from: DateOnly;
  readonly to: DateOnly;
  /** Consecutive days with no dispensible stock. */
  readonly days: number;
  /**
   * The facility's own non-censored daily issue rate during the surrounding
   * activity window: the latent-demand estimate for this spell.
   *
   * Zero when there is no non-censored day to learn from, which is the honest
   * answer and must not be presented as a demand of zero.
   */
  readonly estimatedDailyDemand: number;
}

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/**
 * Find spells where stock was exhausted while the item was still in use.
 *
 * A facility that simply does not stock an item also sits at zero on-hand
 * forever, and reporting that as a stock-out would fill the platform with
 * phantom shortages. A dry spell therefore only counts as censored when the
 * item shows use shortly before or after it — which is also what makes the
 * negative control in the simulator meaningful.
 */
export function detectCensoredIntervals(
  days: readonly LedgerDay[],
  options: CensoringOptions = {},
): readonly CensoredInterval[] {
  const minimumDispenseLevel = options.minimumDispenseLevel ?? 0;
  const activityWindowDays = options.activityWindowDays ?? 30;

  const intervals: CensoredInterval[] = [];
  let runStartIndex = -1;
  let runEndIndex = -1;

  const consider = (startIndex: number, endIndex: number): void => {
    const before = days.slice(Math.max(0, startIndex - activityWindowDays), startIndex);
    const after = days.slice(endIndex + 1, endIndex + 1 + activityWindowDays);
    const surrounding = [...before, ...after];

    if (!surrounding.some((day) => day.issued > 0)) {
      return;
    }

    const dispensable = surrounding.filter((day) => day.onHand > minimumDispenseLevel);
    const estimatedDailyDemand =
      dispensable.length === 0 ? 0 : sum(dispensable.map((day) => day.issued)) / dispensable.length;

    const first = days[startIndex];
    const last = days[endIndex];
    if (first === undefined || last === undefined) {
      return;
    }

    intervals.push({
      from: first.on,
      to: last.on,
      days: endIndex - startIndex + 1,
      estimatedDailyDemand,
    });
  };

  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    if (day === undefined) {
      continue;
    }

    if (day.onHand <= minimumDispenseLevel) {
      if (runStartIndex === -1) {
        runStartIndex = index;
      }
      runEndIndex = index;
      continue;
    }

    if (runStartIndex !== -1) {
      consider(runStartIndex, runEndIndex);
      runStartIndex = -1;
      runEndIndex = -1;
    }
  }

  if (runStartIndex !== -1) {
    consider(runStartIndex, runEndIndex);
  }

  return intervals;
}

export const countCensoredDays = (intervals: readonly CensoredInterval[]): number =>
  intervals.reduce((total, interval) => total + interval.days, 0);
