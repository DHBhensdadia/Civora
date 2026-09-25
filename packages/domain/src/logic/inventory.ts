import type { DemandBasis } from '../model/derived';
import type { LedgerDay } from './ledger';

/**
 * Inventory cover.
 *
 * Small module, high cost of getting it wrong: this is the number an officer
 * looks at to decide whether a facility is in trouble, and a plausible wrong
 * answer here is worse than a visible failure.
 */

/**
 * Below this daily rate, demand is indistinguishable from zero and dividing by
 * it produces a cover figure of arbitrary size. Treating that as "no measurable
 * demand" is the honest reading; the alternative is presenting a facility with
 * one historic issue as having years of cover.
 */
export const DEFAULT_DEMAND_EPSILON = 1e-9;

export const meanOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

/**
 * Days of cover at a given daily demand rate.
 *
 * Returns `null` — not zero, not infinity — when demand cannot be measured, so
 * that every caller is forced to decide how to present an unknown rather than
 * silently treating it as a safe quantity.
 */
export function daysOfStock(
  onHand: number,
  demandRate: number,
  options: { readonly epsilon?: number } = {},
): number | null {
  const epsilon = options.epsilon ?? DEFAULT_DEMAND_EPSILON;
  if (demandRate <= epsilon) {
    return null;
  }
  return onHand / demandRate;
}

/** Units dispensed across a series. */
export const totalIssued = (days: readonly LedgerDay[]): number =>
  days.reduce((total, day) => total + day.issued, 0);

/**
 * The observed daily issue rate: what the ledger recorded, including the days
 * on which nothing could be dispensed.
 *
 * Used only when no day in the window was censored. Where censoring occurred
 * this figure understates need, and `demandRateFromLedger` is the one to call.
 */
export const observedDailyIssues = (days: readonly LedgerDay[]): number =>
  meanOf(days.map((day) => day.issued));

/**
 * The daily rate to compute cover from, and where it came from.
 *
 * If any day in the window was a stock-out, the recorded rate measures what the
 * facility could dispense rather than what it needed, so the rate is taken from
 * the days that were not censored. That correction is the difference between a
 * platform that helps and one that tells a facility with an empty shelf that it
 * has plenty of cover.
 */
export interface DemandRate {
  readonly rate: number;
  readonly basis: DemandBasis;
}

export function demandRateFromLedger(
  days: readonly LedgerDay[],
  options: { readonly minimumDispenseLevel?: number } = {},
): DemandRate {
  const minimumDispenseLevel = options.minimumDispenseLevel ?? 0;
  const dispensable = days.filter((day) => day.onHand > minimumDispenseLevel);

  if (dispensable.length === days.length) {
    return { rate: observedDailyIssues(days), basis: 'observed' };
  }

  return { rate: meanOf(dispensable.map((day) => day.issued)), basis: 'censoring-corrected' };
}
