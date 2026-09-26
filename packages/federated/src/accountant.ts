/**
 * The privacy accountant: a number a reader can check, never a printed guess.
 *
 * The mechanism this package actually runs is the one the accountant prices:
 * each round the coordinator samples a subset of silos, clips each sampled
 * silo's update to norm `C`, adds Gaussian noise `N(0, σ²C²)` to the clipped
 * sum, and divides by the participant count. That is DP-FedAvg
 * (McMahan et al., 2018; Kairouz et al., 2021), and its per-round mechanism is
 * the **Sampled Gaussian Mechanism** with sampling rate `q`, noise multiplier
 * `σ` and sensitivity `C`.
 *
 * Two published results are used, and the tests cite both:
 *
 *  - The Gaussian mechanism's Rényi divergence is exact and simple
 *    (Mironov, 2017, Proposition 3): `ε(α) = α / (2σ²)` at sensitivity 1.
 *  - The sampled mechanism's Rényi divergence for an integer order is the
 *    finite sum below, which is the numerically stable procedure of Mironov,
 *    Talwar & Zhang (2019) — the same formula the TensorFlow Privacy
 *    implementation uses.
 *
 * Composition is addition of Rényi divergences, and the Rényi-to-(ε, δ)
 * conversion is the standard one (Mironov, 2017, §3.3):
 * `ε ≤ ε_RDP(α) + log(1/δ) / (α − 1)`.
 *
 * An implicit accountant would be a liability here: a stated ε that no
 * computation produced is exactly what the ADR forbids.
 */

import { gaussian, streamFor } from './rng';

/** Orders the accountant evaluates. Integer orders, because the sum is finite. */
export const DEFAULT_ORDERS: readonly number[] = Array.from(
  { length: 127 },
  (_unused, index) => index + 2,
);

/** RDP of the Gaussian mechanism at sensitivity 1 (Mironov 2017, Prop. 3). */
export const rdpGaussian = (alpha: number, sigma: number): number => alpha / (2 * sigma * sigma);

const logBinomial = (n: number, k: number): number => {
  let total = 0;
  for (let index = 1; index <= k; index += 1) {
    total += Math.log(n - k + index) - Math.log(index);
  }
  return total;
};

/**
 * RDP of the Sampled Gaussian Mechanism, exact for integer orders.
 *
 * Derivation, stated so the code can be checked against it: with `Q = N(0, σ²)`
 * and `P = (1−q)Q + q·N(1, σ²)`, the divergence `D_α(P‖Q)` is
 * `1/(α−1) · log E_Q[(dP/dQ)^α]`, and expanding the binomial gives the
 * log-sum below. `q = 1` reduces it to the Gaussian, which a test asserts.
 */
export function rdpSampledGaussian(alpha: number, q: number, sigma: number): number {
  if (!Number.isInteger(alpha) || alpha < 2) {
    throw new Error(
      `the accountant evaluates integer Rényi orders of at least two; got ${String(alpha)}`,
    );
  }
  if (sigma <= 0) {
    throw new Error('the noise multiplier must be positive; an unbounded mechanism has no bound');
  }
  if (q <= 0) {
    return 0;
  }
  if (q >= 1) {
    return rdpGaussian(alpha, sigma);
  }

  const logTerms: number[] = [];
  for (let draw = 0; draw <= alpha; draw += 1) {
    logTerms.push(
      logBinomial(alpha, draw) +
        draw * Math.log(q) +
        (alpha - draw) * Math.log(1 - q) +
        (draw * draw - draw) / (2 * sigma * sigma),
    );
  }
  const largest = Math.max(...logTerms);
  const logSum =
    largest + Math.log(logTerms.reduce((total, term) => total + Math.exp(term - largest), 0));
  return logSum / (alpha - 1);
}

export interface PrivacySpend {
  readonly epsilon: number;
  readonly delta: number;
  readonly bestOrder: number;
  readonly ordersEvaluated: number;
  readonly rounds: number;
  readonly samplingRate: number;
  readonly noiseMultiplier: number;
  /** RDP at the chosen order, before the (ε, δ) conversion. */
  readonly rdp: number;
}

export interface AccountingOptions {
  /** Rounds composed. */
  readonly rounds: number;
  /** Share of silos sampled per round, in (0, 1]. */
  readonly samplingRate: number;
  /** Noise multiplier: the Gaussian's standard deviation in units of C. */
  readonly noiseMultiplier: number;
  readonly delta: number;
  readonly orders?: readonly number[];
}

/**
 * Spend the budget: compose the per-round divergences and convert.
 *
 * Rounds in this build share a sampling rate and a noise multiplier, so
 * composition is multiplication; the shape of the code is the general one so a
 * future variable-rate schedule can be priced the same way.
 */
export function accountForRounds(options: AccountingOptions): PrivacySpend {
  const orders = options.orders ?? DEFAULT_ORDERS;
  if (options.rounds <= 0) {
    return {
      epsilon: 0,
      delta: options.delta,
      bestOrder: orders[0] ?? 2,
      ordersEvaluated: orders.length,
      rounds: 0,
      samplingRate: options.samplingRate,
      noiseMultiplier: options.noiseMultiplier,
      rdp: 0,
    };
  }

  const logarithmicDelta = Math.log(1 / options.delta);
  let best: PrivacySpend | null = null;

  for (const order of orders) {
    const perRound = rdpSampledGaussian(order, options.samplingRate, options.noiseMultiplier);
    const rdp = perRound * options.rounds;
    const epsilon = rdp + logarithmicDelta / (order - 1);
    if (best === null || epsilon < best.epsilon) {
      best = {
        epsilon,
        delta: options.delta,
        bestOrder: order,
        ordersEvaluated: orders.length,
        rounds: options.rounds,
        samplingRate: options.samplingRate,
        noiseMultiplier: options.noiseMultiplier,
        rdp,
      };
    }
  }

  if (best === null) {
    throw new Error('no orders were supplied to the accountant');
  }
  return best;
}

/** Cumulative ε after each round, for a ledger that shows the budget filling. */
export function epsilonPerRound(options: AccountingOptions): readonly number[] {
  return Array.from(
    { length: options.rounds },
    (_unused, index) => accountForRounds({ ...options, rounds: index + 1 }).epsilon,
  );
}

/**
 * The noise multiplier a target ε requires, found by bisection.
 *
 * The console and the sweep both need this direction: "what does ε = 8 cost".
 * Bisection rather than algebra because the accountant is a computation, and
 * bisecting the computation keeps the two answers from disagreeing.
 */
export function noiseMultiplierForTarget(input: {
  readonly epsilon: number;
  readonly delta: number;
  readonly rounds: number;
  readonly samplingRate: number;
  readonly tolerance?: number;
}): number {
  const tolerance = input.tolerance ?? 1e-4;
  let low = 0.1;
  let high = 512;
  const spendAt = (sigma: number): number =>
    accountForRounds({
      rounds: input.rounds,
      samplingRate: input.samplingRate,
      noiseMultiplier: sigma,
      delta: input.delta,
    }).epsilon;

  if (spendAt(high) > input.epsilon) {
    throw new Error(
      `even a noise multiplier of ${String(high)} spends more than ε = ${String(input.epsilon)}`,
    );
  }
  while (high - low > tolerance) {
    const middle = (low + high) / 2;
    if (spendAt(middle) <= input.epsilon) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
}

/** Draw one Gaussian sample, exposed so a test can hold the stream fixed. */
export const sampleGaussian = (seed: string, purpose: string): number =>
  gaussian(streamFor(seed, purpose));
