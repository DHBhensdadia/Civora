import type { DateOnly } from '../model/common';

/**
 * Calendar arithmetic on date-only values.
 *
 * Everything here works in UTC and never consults the system clock or the local
 * timezone. A generated dataset has to be byte-identical on a laptop in one
 * country and a build runner in another, and local-time arithmetic is the usual
 * way that guarantee is lost.
 */

export const MILLISECONDS_PER_DAY = 86_400_000;

/** A date-only value as its UTC midnight instant. */
const toUtcMidnight = (date: DateOnly): number => Date.parse(`${date}T00:00:00.000Z`);

const fromUtcMidnight = (milliseconds: number): DateOnly =>
  new Date(milliseconds).toISOString().slice(0, 10);

/** The date part of an instant, in UTC. */
export const toDateOnly = (instant: Date): DateOnly => instant.toISOString().slice(0, 10);

/** The instant at the start of a date-only value, in UTC. */
export const toInstant = (date: DateOnly): string => `${date}T00:00:00.000Z`;

export const addDays = (date: DateOnly, days: number): DateOnly =>
  fromUtcMidnight(toUtcMidnight(date) + days * MILLISECONDS_PER_DAY);

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export const daysBetween = (from: DateOnly, to: DateOnly): number =>
  Math.round((toUtcMidnight(to) - toUtcMidnight(from)) / MILLISECONDS_PER_DAY);

export const compareDateOnly = (left: DateOnly, right: DateOnly): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Every day from `from` to `to`, inclusive, ascending. Empty if `to` precedes `from`. */
export const eachDay = (from: DateOnly, to: DateOnly): readonly DateOnly[] => {
  const total = daysBetween(from, to);
  if (total < 0) {
    return [];
  }
  const days: DateOnly[] = [];
  for (let offset = 0; offset <= total; offset += 1) {
    days.push(addDays(from, offset));
  }
  return days;
};

export const isWithin = (date: DateOnly, from: DateOnly, to: DateOnly): boolean =>
  compareDateOnly(date, from) >= 0 && compareDateOnly(date, to) <= 0;

export const minDate = (dates: readonly DateOnly[]): DateOnly | null =>
  dates.length === 0 ? null : dates.reduce((lowest, date) => (date < lowest ? date : lowest));

export const maxDate = (dates: readonly DateOnly[]): DateOnly | null =>
  dates.length === 0 ? null : dates.reduce((highest, date) => (date > highest ? date : highest));
