import { DEFAULT_LANGUAGE, languageOf } from './languages';
import { messageFor } from './messages';

/**
 * Dates and numbers, in the reader's language.
 *
 * The reason this is a module rather than `toLocaleString` at each call site is
 * the same reason the registry exists: a number a health worker reads has to be
 * grouped and written the way their locale writes numbers, and a date has to be
 * a date they recognise. Two rules are load-bearing:
 *
 *  - **The numbering system is part of the language's own row in the registry.**
 *    Rendering Devanagari numerals is a decision about Hindi, not a formatting
 *    option a caller passes in, so `formatCount(94680, 'hi')` writes `९४,६८०`
 *    without the caller having to know that.
 *  - **Dates are read in UTC.** Every date the platform handles is a civil day
 *    (`2026-09-24`), not an instant. Constructing it in local time would move it
 *    a day for a reader west of Greenwich and make a screenshot disagree with the
 *    record, so the day is parsed and rendered as a day.
 *
 * An unoffered language falls back to the default locale rather than to the raw
 * tag: `Intl` would accept almost anything and silently render something, which
 * is how a French date ends up on a Hindi screenshot.
 */

const localeFor = (language: string): string =>
  (languageOf(language) ?? languageOf(DEFAULT_LANGUAGE) ?? { locale: 'en-IN' }).locale;

/** A number, grouped and written as the reader's language writes it. */
export function formatNumber(
  value: number,
  language: string,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(localeFor(language), {
    maximumFractionDigits: 2,
    ...options,
  }).format(value);
}

/** A whole count — facilities, entries, days of stock. */
export const formatCount = (value: number, language: string): string =>
  formatNumber(value, language, { maximumFractionDigits: 0 });

/** A share, written as a percentage with one decimal place by default. */
export const formatPercent = (value: number, language: string, digits = 1): string =>
  formatNumber(value * 100, language, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }) + '%';

/** A civil day (`2026-09-24`), rendered in the reader's language. */
export function formatDate(day: string, language: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    // Not a civil day: shown as it is, because inventing a date for a malformed
    // one is how a surface ends up displaying certainty about nothing.
    return day;
  }

  const [, year, month, date] = match;
  const instant = new Date(Date.UTC(Number(year), Number(month) - 1, Number(date)));

  return new Intl.DateTimeFormat(localeFor(language), {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(instant);
}

/**
 * A count of days, as a reader reads a stale reading.
 *
 * Composed here rather than at each call site because the numeral and the word
 * have to agree about which language they are in, and because "14 days" is a
 * phrase the bundle carries rather than a word each surface pluralises for
 * itself.
 */
export const formatDays = (days: number, language: string): string =>
  `${formatCount(days, language)} ${messageFor(language, 'common.days')}`;
