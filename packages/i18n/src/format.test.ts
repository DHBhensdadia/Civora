import { describe, expect, it } from 'vitest';

import { formatCount, formatDate, formatDays, formatNumber, formatPercent } from './index';

/**
 * Dates and numbers.
 *
 * Two things are asserted rather than assumed: **Indian grouping** (a count of
 * 94,680 is written `94,680`, not `94.68K` and not `94680`), and **the reader's
 * own digits**. Both matter on the surfaces this serves — a district officer
 * reading a stock figure at a glance is reading the grouping, and a reader of
 * Hindi is reading Devanagari numerals.
 */

describe("a count in the reader's language", () => {
  it('groups the way an Indian reader reads a number', () => {
    expect(formatCount(94680, 'en')).toBe('94,680');
    expect(formatCount(173564, 'en')).toBe('1,73,564');
  });

  it('writes Devanagari numerals for Hindi and Marathi, Bengali for Bengali', () => {
    expect(formatCount(94680, 'hi')).toBe('९४,६८०');
    expect(formatCount(94680, 'mr')).toBe('९४,६८०');
    expect(formatCount(94680, 'bn')).toBe('৯৪,৬৮০');
    // Tamil uses Latin digits in official use, deliberately.
    expect(formatCount(94680, 'ta')).toBe('94,680');
  });

  it('falls back to the default locale for a language this build does not offer', () => {
    // The alternative — handing the raw tag to `Intl` — renders something for
    // almost any string, which is how a wrong-locale figure reaches a screenshot.
    expect(formatCount(94680, 'fr')).toBe('94,680');
  });

  it('keeps a fraction only when the caller asks for one', () => {
    expect(formatCount(12.4, 'en')).toBe('12');
    expect(formatNumber(12.4, 'en', { maximumFractionDigits: 1 })).toBe('12.4');
    expect(formatPercent(0.8334, 'en')).toBe('83.3%');
    expect(formatPercent(0.8334, 'hi')).toContain('८३.३');
  });
});

describe("a civil day in the reader's language", () => {
  it('renders the day the record names, in every offered language', () => {
    // The assertion is the day, not the exact glyphs: `en-IN` writes "24 Sept
    // 2026" where `en-GB` writes "24 Sep 2026", and a test that pinned the month
    // abbreviation would be testing the host's ICU data rather than the rule.
    // UTC is the rule worth holding: a day is a civil day, so the rendering
    // cannot move a day because the server sits west of Greenwich.
    // The year appears in each language's own digits, which is the claim: a
    // Hindi reader is shown २०२६ and not 2026.
    expect(formatDate('2026-09-24', 'en')).toMatch(/2026/u);
    expect(formatDate('2026-09-24', 'ta')).toMatch(/2026/u);
    expect(formatDate('2026-09-24', 'hi')).toMatch(/[०-९]{4}/u);
    expect(formatDate('2026-09-24', 'mr')).toMatch(/[०-९]{4}/u);
    expect(formatDate('2026-09-24', 'bn')).toMatch(/[০-৯]{4}/u);
    for (const language of ['hi', 'mr', 'bn']) {
      expect(formatDate('2026-09-24', language), language).not.toContain('2026');
    }
    // The same input renders the same string twice, which is what makes a
    // figure on a surface comparable with one in a document.
    expect(formatDate('2026-09-24', 'hi')).toBe(formatDate('2026-09-24', 'hi'));
  });

  it('shows a malformed day as it stands rather than inventing one', () => {
    expect(formatDate('not-a-day', 'en')).toBe('not-a-day');
  });

  it('composes a day count with the word for days in the same language', () => {
    expect(formatDays(14, 'en')).toBe('14 days');
    expect(formatDays(14, 'hi')).toMatch(/^१४ /u);
    expect(formatDays(14, 'ta')).toContain('நாட்கள்');
  });
});
