/**
 * A seeded resampler, for the residual bootstrap behind the upper quantile.
 *
 * The generator is the same xorshift-style construction the simulator uses
 * (`apps/simulator/src/rng.ts`), and it is deliberately a separate copy rather
 * than a shared module: one draws a country, this one draws residuals, and if
 * either implementation changed the other's numbers would move with it. A
 * shared utility should arrive when a third consumer does — until then the two
 * are independent by design, and both are small enough to read in full.
 *
 * The reason it exists at all is determinism. A forecast that used
 * `Math.random` could not be reproduced from its own recorded seed, and a
 * platform that asks an officer to move stock between districts does not get to
 * answer "the numbers changed when I ran it again".
 */

export interface Sampler {
  /** Index in [0, size), chosen uniformly. */
  index(size: number): number;
  /** One element, chosen uniformly. Throws on an empty list. */
  pick<T>(items: readonly T[]): T;
}

/** FNV-1a over the seed text. */
const hashSeed = (seed: string): number => {
  let hash = 2_166_136_261;
  for (let position = 0; position < seed.length; position += 1) {
    hash ^= seed.charCodeAt(position);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

export function createSampler(seed: string): Sampler {
  let state = hashSeed(seed) || 0x9e3779b9;

  const nextUint32 = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };

  const index = (size: number): number => {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`a sample cannot be drawn from a list of ${String(size)}`);
    }
    return nextUint32() % size;
  };

  const pick = <T>(items: readonly T[]): T => {
    const value = items[index(items.length)];
    if (value === undefined) {
      throw new Error('a sample cannot be drawn from an empty list');
    }
    return value;
  };

  return { index, pick };
}
