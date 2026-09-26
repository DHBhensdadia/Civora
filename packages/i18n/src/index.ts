/**
 * `@civora/i18n` — language and script support.
 *
 * Scope: the languages the platform offers, the locale bundles the capture and
 * alert flows read, and the formatting rules (dates, counts, percentages) those
 * flows depend on.
 *
 * Text that reaches a health worker reaches them in their own language, and a
 * bundle missing a key fails the build rather than silently falling back to
 * English.
 *
 * **Built today:** the language registry (`LANGUAGES`, `languageOf`,
 * `isSupported`, `languageLabelOf`, `speechTagOf`) — which languages a reader
 * may ask for, named in their own script, with the `Intl` locale each of them
 * renders in and the plain tag a voice is handed; the **locale bundles**
 * (`BUNDLES`, `bundleFor`, `messageFor`, `MESSAGE_KEYS`), a total record per
 * language over a typed key union covering the capture and alert flows; the
 * formatting helpers (`formatNumber`, `formatCount`, `formatPercent`,
 * `formatDate`, `formatDays`) that render a figure the way the language writes
 * it; and the **record reader** (`bodyIn`, `heldLanguages`) that answers with a
 * body the record actually holds in a language, or with nothing — never with
 * another language's text wearing the tag that was asked for.
 *
 * **Not built:** machine translation of anything not in a bundle. A register a
 * facility photographs, a sentence a health worker speaks and a risk driver's
 * own detail line are English plus whatever a model wrote; the surfaces say so
 * rather than pretending the application is translated.
 */

export {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  isSupported,
  languageCodes,
  languageLabelOf,
  languageOf,
  speechTagOf,
} from './languages';
export type { Language } from './languages';

export { bodyIn, heldLanguages } from './bodies';

export {
  BUNDLES,
  MESSAGE_KEYS,
  bundleFor,
  defaultBundle,
  messageFor,
  messageKeys,
} from './messages';
export type { LocaleBundle, MessageKey } from './messages';

export { formatCount, formatDate, formatDays, formatNumber, formatPercent } from './format';
