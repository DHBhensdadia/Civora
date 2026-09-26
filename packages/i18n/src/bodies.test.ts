import { describe, expect, it } from 'vitest';

import { bodyIn, heldLanguages } from './bodies';
import { LANGUAGES, speechTagOf } from './languages';

/**
 * The record's own answer, and the one case that must never be answered with
 * another language's text.
 */

describe('reading a record’s bodies', () => {
  const bodies = {
    en: 'Paracetamol at Ganjam PHC is at 0.8 days of cover.',
    hi: 'गंजाम केंद्र पर पैरासिटामोल का भंडार 0.8 दिन का है।',
  };

  it('answers with the record’s own words in the language asked for', () => {
    expect(bodyIn(bodies, 'hi')).toBe('गंजाम केंद्र पर पैरासिटामोल का भंडार 0.8 दिन का है।');
  });

  it('answers null for a language the record holds no body in, rather than the English one', () => {
    // The blocking case: a Marathi reader must not be read English words in a
    // Marathi voice. Null makes the caller report it instead.
    expect(bodyIn(bodies, 'mr')).toBeNull();
    expect(bodyIn(bodies, 'ta')).toBeNull();
  });

  it('treats an empty or whitespace body as absent', () => {
    expect(bodyIn({ en: '', hi: '   ' }, 'en')).toBeNull();
    expect(bodyIn({ en: '', hi: '   ' }, 'hi')).toBeNull();
  });

  it('does not match a different spelling of the same language', () => {
    // `hi` and `hi-IN` are different keys, and a record is keyed by the tag it
    // was written under. A looser match would answer a question nobody asked.
    expect(bodyIn(bodies, 'hi-IN')).toBeNull();
    expect(bodyIn(bodies, 'HI')).toBeNull();
  });

  it('does not treat inherited object properties as languages', () => {
    expect(bodyIn(bodies, 'toString')).toBeNull();
    expect(bodyIn(bodies, 'constructor')).toBeNull();
  });

  it('reports the languages held, in the order the record holds them', () => {
    expect(heldLanguages(bodies)).toEqual(['en', 'hi']);
    expect(heldLanguages({})).toEqual([]);
    expect(heldLanguages({ ta: '  ', bn: ' done ' })).toEqual(['bn']);
  });
});

describe('the tags handed to a voice', () => {
  it('gives every offered language a plain speech tag, without Intl extensions', () => {
    for (const language of LANGUAGES) {
      expect(speechTagOf(language.code)).toBe(language.speech);
      // The failure this prevents: `hi-IN-u-nu-deva` matches no installed voice,
      // and a platform that spoke with it would silently read nothing.
      expect(language.speech).not.toContain('-u-');
      expect(language.speech).toBe(language.code === 'en' ? 'en-IN' : `${language.code}-IN`);
    }
  });

  it('answers null for a language it does not offer rather than echoing the tag', () => {
    expect(speechTagOf('fr')).toBeNull();
    expect(speechTagOf('')).toBeNull();
  });
});
