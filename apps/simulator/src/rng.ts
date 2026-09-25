/**
 * The generator behind every random-looking value in the dataset.
 *
 * Determinism is the whole requirement: the same seed must produce the same
 * dataset on a laptop in Bhubaneswar and a build runner in another country, so
 * every number in the deck can be reproduced by anyone who reads the seed. That
 * rules out `Math.random`, and it also rules out anything that depends on
 * floating-point edge behaviour or iteration order.
 *
 * The algorithm is a 32-bit xorshift-style generator seeded through FNV-1a.
 * It is not statistically strong and does not need to be: nothing here is
 * adversarial, and a generator small enough to read in full is worth more than
 * one whose properties have to be taken on trust.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** Uniform real number in [min, max). */
  float(min: number, max: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** One element, chosen uniformly. Throws on an empty list rather than returning nothing. */
  pick<T>(items: readonly T[]): T;
  /**
   * An element chosen with relative weights, for behaviour that is not uniform:
   * most items are fast-moving and a few are rare, and a uniform choice would
   * make a plausible catalogue and an implausible movement pattern.
   */
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  /** A value shaped like a normal distribution, clamped to a sensible range. */
  normal(mean: number, standardDeviation: number): number;
}

/** FNV-1a over the string form of the seed. */
const hashSeed = (seed: string | number): number => {
  const text = typeof seed === 'number' ? `seed:${String(seed)}` : seed;
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

export function createRng(seed: string | number): Rng {
  let state = hashSeed(seed) || 0x9e3779b9;

  const nextUint32 = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };

  const next = (): number => nextUint32() / 4_294_967_296;

  const int = (min: number, max: number): number => {
    if (max < min) {
      throw new Error(`invalid range: ${String(min)} to ${String(max)}`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };

  const float = (min: number, max: number): number => min + next() * (max - min);

  const pick = <T>(items: readonly T[]): T => {
    const value = items[int(0, items.length - 1)];
    if (value === undefined) {
      throw new Error('cannot pick from an empty list');
    }
    return value;
  };

  return {
    next,
    int,
    float,
    chance: (probability) => next() < probability,
    pick,
    weighted: <T>(entries: readonly (readonly [T, number])[]): T => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      if (total <= 0) {
        throw new Error('cannot pick from weights that sum to zero');
      }
      let threshold = next() * total;
      for (const [value, weight] of entries) {
        threshold -= weight;
        if (threshold <= 0) {
          return value;
        }
      }
      const last = entries[entries.length - 1];
      if (last === undefined) {
        throw new Error('cannot pick from an empty list');
      }
      return last[0];
    },
    normal: (mean, standardDeviation) => {
      // Irwin–Hall: the sum of three uniforms, which is close enough to normal
      // for demand noise and never produces the long tails a Box–Muller call
      // would hand to a stock calculation.
      const sample = next() + next() + next() - 1.5;
      return mean + sample * 2 * standardDeviation;
    },
  };
}

/**
 * A seed derived from a parent seed and a label.
 *
 * Used to give each layer of the dataset its own stream, so that adding a
 * behaviour to one layer cannot shift the numbers in another. Without this,
 * every change to the generator changes every figure in the deck.
 */
export const deriveSeed = (seed: string | number, label: string): string =>
  `${String(seed)}/${label}`;
