import type { Fact } from '@civora/domain';
import type { ZodType } from 'zod';

/**
 * The grounding rule, as a check rather than a promise.
 *
 * The platform's answer to "can a model be trusted to explain a decision without
 * inventing a number" is not a careful prompt. It is this: every numeral written
 * in a narrative has to appear, exactly, in the fact set the narrative was
 * written from, and if one does not then the answer is not an answer.
 *
 * It is implemented as a refinement on the caller's own schema, which matters
 * for two reasons. The adapter validates every answer against the schema it was
 * given before returning it, so an ungrounded draft is *rejected where every
 * other malformed answer is*: it is retried with the complaint fed back, and a
 * model that invents a figure is given the chance to remove it. And the rule
 * travels with the request — a caller cannot forget to check, because the schema
 * it asked to be validated against is the one that carries the check.
 *
 * What it deliberately does not do is arithmetic. A percentage computed from a
 * probability is a number the facts do not contain, and it is rejected, because
 * accepting it would mean the platform could no longer say that every quantity a
 * reader sees came from its own engines.
 */

/** One numeral, reduced to the form a comparison can be made in. */
const canonical = (raw: string): string => raw.replace(/,/g, '').replace(/\.+$/, '');

/**
 * Every numeral written in a piece of prose.
 *
 * Grouping separators are stripped, because "1,042,492" and "1042492" are the
 * same quantity written by two conventions and neither is an invention.
 */
export function numeralsIn(text: string): readonly string[] {
  return [...text.matchAll(/\d[\d.,]*/g)].map((match) => canonical(match[0]));
}

/** The numerals a narrative is allowed to contain, from the facts it was given. */
export function allowedNumeralsOf(facts: readonly Fact[]): ReadonlySet<string> {
  return new Set(facts.flatMap((fact) => numeralsIn(String(fact.value))));
}

/**
 * The numerals in a piece of prose that the facts do not carry.
 *
 * Returned as sentences rather than as a boolean, because the message is also
 * the correction: it goes back to the model on the retry, naming the figure that
 * has no source.
 */
export function groundingProblems(text: string, facts: readonly Fact[]): readonly string[] {
  const allowed = allowedNumeralsOf(facts);

  return [...new Set(numeralsIn(text))]
    .filter((numeral) => !allowed.has(numeral))
    .map(
      (numeral) =>
        `the number ${numeral} is not in the supplied facts; state no quantity that was not given to you`,
    );
}

/**
 * Wrap a schema so that an answer containing an ungrounded numeral fails it.
 *
 * The texts to check are declared by the caller rather than inferred, because a
 * schema is the only thing that knows which of its fields are read by a person
 * and which are identifiers.
 */
export function grounded<T>(
  schema: ZodType<T>,
  facts: readonly Fact[],
  textsOf: (value: T) => readonly (readonly [string, string])[],
): ZodType<T> {
  return schema.superRefine((value, context) => {
    for (const [field, text] of textsOf(value)) {
      for (const problem of groundingProblems(text, facts)) {
        context.addIssue({ code: 'custom', message: problem, path: [field] });
      }
    }
  });
}
