import type { Item } from '../model/catalogue';

/**
 * Matching a name somebody wrote to an item in the catalogue.
 *
 * This exists because the platform's extraction path deliberately refuses to let
 * a model produce an identifier. A photograph is read as *text* — "Paracetamol
 * 500 mg Tab", abbreviated, misspelled, or in a different script — and this is
 * where that text becomes one of the seventy items the platform stocks. The
 * decision is deterministic, testable and reviewable, and it is allowed to
 * return *no answer*: a name that matches nothing, or matches two items equally
 * well, becomes a question for a person rather than a guess filed against a
 * shelf.
 *
 * The alternative — asking the model which item it meant, or accepting the
 * closest catalogue entry — would put a fabricated identity behind a real
 * quantity, and a wrong item is worse than a missing one: it moves stock that
 * nobody is short of and leaves the shortage where it was.
 */

/** What a written name resolved to. */
export type ItemMatch =
  | { readonly kind: 'matched'; readonly item: Item }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly Item[] }
  | { readonly kind: 'unmatched' };

/**
 * Reduce a written name to comparable words.
 *
 * Case, punctuation, brackets and spacing are removed rather than guessed
 * around; nothing is expanded, because an abbreviation table is a source that
 * has to be cited and this one is not.
 */
const words = (name: string): readonly string[] =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');

const contains = (written: readonly string[], needed: readonly string[]): boolean =>
  needed.every((word) => written.includes(word));

/**
 * Resolve one written name against the catalogue.
 *
 * Two passes. The first accepts an item only when every word of its generic name
 * appears in what was written, so "tab paracetamol 500" finds Paracetamol and
 * "paracetamol syrup" does not find it by accident. When that leaves more than
 * one entry — the usual case being the same medicine at two strengths — the
 * second pass narrows by the strength the page states, and only by a strength
 * that appears in full.
 *
 * Anything still tied is `ambiguous`, and it is reported with its candidates so
 * the review queue can offer them to a person. That is the honest outcome: a
 * human choosing between two catalogue entries is cheap, and the platform
 * choosing wrongly is not.
 */
export function matchItemByName(name: string, items: readonly Item[]): ItemMatch {
  const written = words(name);
  if (written.length === 0) {
    return { kind: 'unmatched' };
  }

  const named = items.filter((item) => contains(written, words(item.genericName)));
  if (named.length === 0) {
    return { kind: 'unmatched' };
  }
  if (named.length === 1) {
    const [only] = named;
    return only === undefined ? { kind: 'unmatched' } : { kind: 'matched', item: only };
  }

  const byStrength = named.filter((item) => contains(written, words(item.strength)));
  if (byStrength.length === 1) {
    const [only] = byStrength;
    return only === undefined ? { kind: 'unmatched' } : { kind: 'matched', item: only };
  }

  return { kind: 'ambiguous', candidates: byStrength.length > 0 ? byStrength : named };
}
