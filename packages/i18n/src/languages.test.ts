import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  isSupported,
  languageCodes,
  languageLabelOf,
  languageOf,
} from './index';

/**
 * The language registry.
 *
 * Small, and worth testing for one reason: every surface that talks about
 * language reads it, so a code that is malformed, duplicated or missing its
 * native name would be wrong everywhere at once.
 */

describe('the languages the platform offers', () => {
  it('gives every language a primary tag, both names and a script', () => {
    for (const language of LANGUAGES) {
      expect(language.code).toMatch(/^[a-z]{2}$/);
      expect(language.english.trim()).not.toBe('');
      expect(language.native.trim()).not.toBe('');
      expect(language.script.trim()).not.toBe('');
    }
  });

  it('offers each language once, and lists them in the order they are keyed', () => {
    expect(new Set(languageCodes).size).toBe(LANGUAGES.length);
    expect(languageCodes).toEqual(LANGUAGES.map((language) => language.code));
  });

  it('names a language in its own script, which is how its readers know it', () => {
    expect(languageOf('hi')?.native).toBe('हिन्दी');
    expect(languageLabelOf('ta')).toContain('தமிழ்');
    expect(languageLabelOf('ta')).toContain('Tamil');
    // A language whose own name is already English is not labelled twice.
    expect(languageLabelOf('en')).toBe('English');
  });

  it('covers the two languages an alert record already carries a body in', () => {
    // The alert template seeds `bodies` with English and Hindi, so a reader
    // opening an alert is guaranteed one of those. A registry that dropped
    // either would leave the advisory writer unable to name a language it is
    // handed, so the two lists have to agree.
    expect(isSupported('en')).toBe(true);
    expect(isSupported('hi')).toBe(true);
    expect(isSupported(DEFAULT_LANGUAGE)).toBe(true);
  });

  it('answers an unknown tag with the tag rather than with English', () => {
    // A record may carry a language this build does not offer. Mislabelling it
    // as English would be a lie about what is being shown; showing the tag does
    // not.
    expect(languageOf('fr')).toBeNull();
    expect(isSupported('fr')).toBe(false);
    expect(languageLabelOf('fr')).toBe('fr');
    // Exact match: a request for a regional variant is not a language here.
    expect(isSupported('hi-IN')).toBe(false);
  });
});
