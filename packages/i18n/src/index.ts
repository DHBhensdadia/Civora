/**
 * `@civora/i18n` — language and script support.
 *
 * Scope: locale bundles for the languages the front line actually uses, the
 * translation helper used by the capture and alert flows, and the formatting
 * rules (dates, units, numerals) those flows depend on.
 *
 * Text that reaches a health worker reaches them in their own language, and a
 * bundle missing a key fails the build rather than silently falling back to
 * English.
 *
 * Not implemented yet. Locale bundles land with the capture and alert flows,
 * which are localised first.
 */
export {};
