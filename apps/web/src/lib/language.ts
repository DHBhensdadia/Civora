import { DEFAULT_LANGUAGE, LANGUAGES, isSupported, languageLabelOf } from '@civora/i18n';

/**
 * The language the interface is reading in.
 *
 * A cookie rather than a route, because it is a property of the person and not
 * of the record: a health worker who reads Hindi reads every surface in Hindi
 * until they say otherwise. It is deliberately **not** part of the session —
 * a session is who somebody is and what they may do, and a language is neither —
 * so switching language does not touch an authorisation decision, and switching
 * role does not lose the language.
 *
 * Two facts are kept apart, exactly as `@civora/i18n` keeps them. The language
 * chosen here is an **interface preference**: it selects which bundle the
 * capture and alert flows read. It does not claim that an alert record carries a
 * body in that language, and it does not translate a register a facility
 * photographed or a sentence a health worker spoke.
 */

export const LANGUAGE_COOKIE = 'civora-language';

/** The language a cookie asks for, or the default when it asks for none this build offers. */
export const languageFrom = (raw: string | undefined): string =>
  raw !== undefined && isSupported(raw) ? raw : DEFAULT_LANGUAGE;

/** The offered languages, with the label a reader sees. */
export const offeredLanguages = (): readonly { readonly code: string; readonly label: string }[] =>
  LANGUAGES.map((language) => ({
    code: language.code,
    label: languageLabelOf(language.code),
  }));
