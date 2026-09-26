/**
 * Determinism is a requirement here, not a convenience.
 *
 * A federated round involves three separate pieces of randomness — which silos
 * the coordinator samples, the order a silo walks its own records in, and the
 * noise itself — and if any of them came from `Math.random()` the round ledger
 * would be unreproducible and the privacy accounting unverifiable. Every draw in
 * this package comes from a seed that travels in the configuration, so two runs
 * of the same configuration produce the same round ledger and the same model,
 * and a test asserts exactly that.
 */

/** FNV-1a over the seed string, so a human-readable seed names a stream. */
const hashSeed = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** A 32-bit generator: small, fast, and identical on every machine. */
export function seededRng(seed: string): () => number {
  let state = hashSeed(seed) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One draw from N(0, 1) per pair of uniforms (Box–Muller).
 *
 * The pair is computed twice rather than cached, which costs a little time and
 * buys a property that matters more: drawing the *k*th number is a pure function
 * of the stream, so adding a draw somewhere does not shift every later one.
 */
export function gaussian(rng: () => number): number {
  const first = Math.max(rng(), Number.MIN_VALUE);
  const second = rng();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

/** `count` distinct indices from `[0, size)`, by partial Fisher–Yates. */
export function sampleDistinct(rng: () => number, size: number, count: number): readonly number[] {
  const drawn = Math.max(0, Math.min(size, Math.floor(count)));
  const pool = Array.from({ length: size }, (_unused, index) => index);
  for (let position = 0; position < drawn; position += 1) {
    const swapWith = position + Math.floor(rng() * (size - position));
    const held = pool[position] ?? 0;
    pool[position] = pool[swapWith] ?? 0;
    pool[swapWith] = held;
  }
  return pool.slice(0, drawn);
}

/** A shuffled copy, deterministically, without touching the caller's array. */
export function shuffled<T>(rng: () => number, values: readonly T[]): readonly T[] {
  const copy = [...values];
  for (let position = copy.length - 1; position > 0; position -= 1) {
    const swapWith = Math.floor(rng() * (position + 1));
    const held = copy[position] as T;
    copy[position] = copy[swapWith] as T;
    copy[swapWith] = held;
  }
  return copy;
}

/** A stream named by a private purpose, so two draws cannot accidentally share. */
export const streamFor = (seed: string, purpose: string): (() => number) =>
  seededRng(`${seed}|${purpose}`);
