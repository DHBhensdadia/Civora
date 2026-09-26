/**
 * The languages this platform can address a reader in.
 *
 * A registry rather than a scatter of string literals, because a language is
 * something more than its tag: a reader is shown a name they recognise, in their
 * own script, and a body written in the language they read. Everything that needs
 * to talk to a person about language — an advisory, a capture form, a language
 * picker — reads this list, so a language cannot be half-added: added to the
 * picker and missing from the writer, or the reverse.
 *
 * Three claims are kept deliberately apart, because conflating them is how a
 * platform overclaims:
 *
 *  - **Offered.** The languages in this list. A reader can ask for any of them.
 *  - **Carried.** A language an alert record actually holds a body in. That is a
 *    fact about the record, read off `Object.keys(alert.bodies)`, not a claim
 *    made here — today the alert template writes English and Hindi, so those are
 *    the two languages in which a reader is guaranteed to find something the
 *    moment an alert is raised.
 *  - **Written.** A language a model has produced grounded prose in. That is a
 *    fact about a run, and it is reported per alert rather than here.
 *
 * Keeping them apart is what stops "we support five languages" from meaning "we
 * have five translations of one template".
 */

export interface Language {
  /** BCP-47 primary language tag, which is what every record is keyed by. */
  readonly code: string;
  /** The language's name in English, for a reader who is not reading it. */
  readonly english: string;
  /** The language's name in its own script, which is how its readers know it. */
  readonly native: string;
  /** The script it is written in. */
  readonly script: string;
  /**
   * The tag handed to `Intl` for dates and numbers, script included.
   *
   * `hi-IN` alone would render Latin digits on most platforms; the language is
   * written in Devanagari and a reader of it expects Devanagari numerals, so the
   * numbering system is part of the tag rather than a default to be discovered at
   * runtime. `ta-IN` carries no override for the same reason: Tamil is written
   * with Latin digits in official use, so asking for Tamil numerals would be the
   * affectation, not the honesty.
   */
  readonly locale: string;
  /** The numbering system `locale` renders digits in, named for the record. */
  readonly numberingSystem: 'latn' | 'deva' | 'beng';
  /**
   * The tag handed to a speech synthesiser, which is not the `Intl` tag.
   *
   * `locale` carries a numbering-system extension so a date renders in the
   * language's own digits; a voice engine matching against that tag finds no
   * voice, which is how a platform ends up reading Hindi text in an American
   * accent. A voice wants the plain language tag, and a device with no voice for
   * it is reported rather than faked.
   */
  readonly speech: string;
}

/**
 * The languages the front line records and reads in.
 *
 * English and Hindi are the two the alert record already carries bodies for.
 * Marathi, Bengali and Tamil are offered — a reader can ask for them, and the
 * interface labels them — but no alert body exists in them yet, and the advisory
 * panel says so per language rather than showing a blank space where a body
 * should be. That is Phase 8's work, and pretending otherwise here would be the
 * exact overclaim this file exists to avoid.
 */
export const LANGUAGES: readonly Language[] = [
  {
    code: 'en',
    english: 'English',
    native: 'English',
    script: 'Latin',
    locale: 'en-IN',
    numberingSystem: 'latn',
    speech: 'en-IN',
  },
  {
    code: 'hi',
    english: 'Hindi',
    native: 'हिन्दी',
    script: 'Devanagari',
    locale: 'hi-IN-u-nu-deva',
    numberingSystem: 'deva',
    speech: 'hi-IN',
  },
  {
    code: 'mr',
    english: 'Marathi',
    native: 'मराठी',
    script: 'Devanagari',
    locale: 'mr-IN-u-nu-deva',
    numberingSystem: 'deva',
    speech: 'mr-IN',
  },
  {
    code: 'bn',
    english: 'Bengali',
    native: 'বাংলা',
    script: 'Bengali',
    locale: 'bn-IN-u-nu-beng',
    numberingSystem: 'beng',
    speech: 'bn-IN',
  },
  {
    code: 'ta',
    english: 'Tamil',
    native: 'தமிழ்',
    script: 'Tamil',
    locale: 'ta-IN',
    numberingSystem: 'latn',
    speech: 'ta-IN',
  },
] as const;

/** The language a reader is shown when nothing else is known. */
export const DEFAULT_LANGUAGE = 'en';

/** Every offered language tag, in the order they are listed above. */
export const languageCodes: readonly string[] = LANGUAGES.map((language) => language.code);

/** The tag, if this platform offers that language. Exact match: `hi` is a language, `hi-IN` is a request. */
export const languageOf = (code: string): Language | null =>
  LANGUAGES.find((language) => language.code === code) ?? null;

/** Whether a tag is one of the offered languages. */
export const isSupported = (code: string): boolean => languageOf(code) !== null;

/**
 * The tag to hand a voice for a language, or null when the language is not
 * offered here. Null rather than the tag echoed back, because a caller that is
 * about to speak needs to know it would be speaking something the platform does
 * not offer rather than being told a tag that resolves to no voice.
 */
export const speechTagOf = (code: string): string | null => languageOf(code)?.speech ?? null;

/**
 * How to name a language in a list a person reads.
 *
 * An unknown tag is answered with the tag itself rather than with English or an
 * error: a record may carry a language this build does not offer, and a surface
 * that mislabelled it as English would be lying about what it is showing. A
 * fallback that shows the reader exactly what the record says does not.
 */
export const languageLabelOf = (code: string): string => {
  const language = languageOf(code);
  if (language === null) {
    return code;
  }
  // A language whose own name is already English is not labelled twice: a reader
  // seeing "English · English" learns nothing and stops reading the label.
  return language.native === language.english
    ? language.english
    : `${language.native} · ${language.english}`;
};
