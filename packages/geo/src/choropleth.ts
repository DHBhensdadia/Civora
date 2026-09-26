/**
 * Turning a column of figures into shades on a map.
 *
 * A choropleth is a claim about distribution, so the rule that makes it is here
 * rather than in a component: **equal-interval classes over the observed range**,
 * computed once per read and shared by the legend and the fills. Equal-interval
 * rather than quantile because the question this map answers is "where is the
 * risk concentrated", and a quantile map answers a different one — it makes any
 * distribution look evenly spread by construction, which is the opposite of
 * showing a concentration.
 *
 * Two states are named rather than inferred:
 *
 *  - **No value.** A region the platform has no figure for is not a region with
 *    the smallest figure, so `classIndexFor(null)` is null and the map draws it
 *    as its own state. This is the same rule the ledger applies to a facility it
 *    has not heard from.
 *  - **One class.** When every value is equal, the range collapses; a legend of
 *    eight identical bands would be a lie about resolution, so the map reports a
 *    single class and says the values are equal.
 */

export interface ChoroplethClass {
  /** Inclusive lower bound. */
  readonly from: number;
  /** Inclusive upper bound, except the last class, which is open. */
  readonly to: number;
  /** What the legend prints for this band. */
  readonly label: string;
}

export interface Choropleth {
  readonly classes: readonly ChoroplethClass[];
  /** Smallest and largest value read, or null when nothing was read. */
  readonly min: number | null;
  readonly max: number | null;
  /** Every class covers the same width when there is more than one. */
  readonly interval: number | null;
  /** True when every observed value was equal, so there is nothing to shade. */
  readonly uniform: boolean;
  /** Which class a value falls in, or null for no value. */
  readonly classIndexFor: (value: number | null) => number | null;
}

/** How many bands a map legend carries by default. */
export const DEFAULT_CLASS_COUNT = 5;

const label = (from: number, to: number, last: boolean): string =>
  last ? `${trim(from)} +` : `${trim(from)} – ${trim(to)}`;

const trim = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);

/**
 * Build the classes for a set of values.
 *
 * Nulls are counted as no-value and are ignored by the range, which is the point
 * of accepting them here: a caller that filtered them out first would silently
 * turn "unknown" into "the smallest number present".
 */
export function choroplethFor(
  values: readonly (number | null)[],
  options: { readonly classCount?: number } = {},
): Choropleth {
  const classCount = Math.max(2, options.classCount ?? DEFAULT_CLASS_COUNT);
  const observed = values.filter((value): value is number => value !== null);

  if (observed.length === 0) {
    return {
      classes: [],
      min: null,
      max: null,
      interval: null,
      uniform: true,
      classIndexFor: () => null,
    };
  }

  const min = Math.min(...observed);
  const max = Math.max(...observed);

  if (min === max) {
    return {
      classes: [{ from: min, to: max, label: trim(min) }],
      min,
      max,
      interval: 0,
      uniform: true,
      classIndexFor: (value) => (value === null ? null : 0),
    };
  }

  const interval = (max - min) / classCount;
  const classes: ChoroplethClass[] = [];
  for (let index = 0; index < classCount; index += 1) {
    const from = min + interval * index;
    const to = index === classCount - 1 ? max : min + interval * (index + 1);
    classes.push({ from, to, label: label(from, to, index === classCount - 1) });
  }

  return {
    classes,
    min,
    max,
    interval,
    uniform: false,
    // A value on a boundary falls into the class above it, except the maximum,
    // which belongs to the last class: `Math.floor` would otherwise put the
    // largest figure in the country into no class at all.
    classIndexFor: (value) => {
      if (value === null) {
        return null;
      }
      if (value === max) {
        return classCount - 1;
      }
      const index = Math.floor((value - min) / interval);
      return Math.min(Math.max(index, 0), classCount - 1);
    },
  };
}
