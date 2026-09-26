/**
 * A body an alert record holds, read in the language the reader is reading.
 *
 * The registry keeps three claims apart — **offered** (this build has a bundle),
 * **carried** (the record holds a body in a language) and **written** (a model
 * produced grounded prose in a run). This file is the one that reads the second
 * claim off the record, and its whole job is to refuse to conflate it with the
 * first.
 *
 * A surface that speaks an alert aloud has a choice the moment a language has no
 * body: read another language's words in this language's voice, or say that
 * nothing is there. The first is the failure this function exists to make
 * impossible — an English sentence delivered by a Hindi voice is a claim that
 * the record says something it does not — so the answer here is `null`, and the
 * caller reports it rather than filling the silence.
 *
 * A body that is present but empty is treated as absent. A writer that stored
 * `''` has not written prose, and a surface that rendered one would show a
 * silence a reader would take for agreement.
 */

/**
 * The body this record holds in this language, or `null` when it holds none.
 *
 * Exact match, deliberately: a record keyed `hi` is asked for `hi`. No language
 * fallback, no script matching, no guessing that `hi-IN` and `hi` are the same
 * request — a record is keyed by the tag the platform wrote it under, and a
 * looser match would answer a question nobody asked.
 */
export const bodyIn = (
  bodies: Readonly<Record<string, string>>,
  language: string,
): string | null => {
  // `hasOwn` rather than a truthiness check: a record is a plain object, and
  // `bodies['toString']` would otherwise answer with a function inherited from
  // the prototype — a language nobody wrote and a body that is not a string.
  if (!Object.hasOwn(bodies, language)) {
    return null;
  }
  const body = bodies[language];
  if (body === undefined) {
    return null;
  }
  const trimmed = body.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * The languages a record holds a body in, in the order it holds them.
 *
 * Reported rather than summarised, for the same reason `advisoryLanguagesOf`
 * is: an alert held in two languages and one held in five are different
 * records, and a count alone would not tell a reader which.
 */
export const heldLanguages = (bodies: Readonly<Record<string, string>>): readonly string[] =>
  Object.keys(bodies).filter((language) => bodyIn(bodies, language) !== null);
