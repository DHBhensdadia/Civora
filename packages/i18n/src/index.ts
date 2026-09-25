/**
 * `@civora/i18n` — language and script support.
 *
 * Scope: the languages the platform offers, the locale bundles the capture and
 * alert flows read, and the formatting rules (dates, units, numerals) those flows
 * depend on.
 *
 * Text that reaches a health worker reaches them in their own language, and a
 * bundle missing a key fails the build rather than silently falling back to
 * English.
 *
 * **Built today:** the language registry (`LANGUAGES`, `languageOf`, `isSupported`,
 * `languageLabelOf`) — which languages a reader may ask for, named in their own
 * script, and which of them a record actually carries a body in. The advisory
 * writer and the advisory panel read it, so a language is added in one place.
 *
 * **Not built:** the locale bundles and the formatting helpers. They land with the
 * capture and alert flows (Phase 8), which are localised first.
 */

export {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  isSupported,
  languageCodes,
  languageLabelOf,
  languageOf,
} from './languages';
export type { Language } from './languages';
