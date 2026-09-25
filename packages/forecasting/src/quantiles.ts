import { createSampler } from './randomness';
import { quantile } from './series';

/**
 * The upper bound on demand, from the fit's own mistakes.
 *
 * A Gaussian interval would be a fiction here. Demand for one medicine at one
 * facility is zero on most days and spiky on the rest, so the shape of the
 * uncertainty is not a bell: it is whatever the residuals say it is, and that is
 * what this measures.
 *
 * Paths are built by concatenating **blocks** of consecutive residuals (the
 * moving-block bootstrap) rather than drawing each day independently, and the
 * choice is the difference between an interval that survives a surge and one
 * that does not. When consumption has just stepped up — a surge, a new
 * programme, a referral pattern that changed — the fit is wrong in the *same
 * direction* for many days running, and its residuals are autocorrelated.
 * Independent draws would average that away and hand back a confident interval
 * for the exact fortnight an officer is planning over. Consecutive draws keep
 * the runs that carry the signal.
 *
 * Two quantities come back, because two different questions get asked of them:
 *
 *  - **`daily`** — the bound on one day's demand. This is what the forecast
 *    contract carries.
 *  - **`cumulative`** — the bound on demand *through* each day, which is what
 *    decides whether a lead time's worth of stock is enough. Resampled blocks
 *    are what make this honest: summing independent days would understate the
 *    risk of a sustained surge by a wide margin, and that sum is the number the
 *    redistribution optimiser will act on.
 */

export interface BootstrapOptions {
  /** Resampled paths. More is smoother and slower; 400 is enough for a p90. */
  readonly replications: number;
  /** The quantile to report, between 0.5 and 0.999. */
  readonly level: number;
  readonly seed: string;
  /** Consecutive residuals per block. Defaults to a week. */
  readonly blockLength?: number;
}

export interface QuantileBounds {
  /** The quantile of demand on each day, taken marginally. */
  readonly daily: readonly number[];
  /** The quantile of demand accumulated through each day. */
  readonly cumulative: readonly number[];
}

/** Fewer residuals than this and the sample cannot describe a tail. */
export const MINIMUM_RESIDUALS = 4;

const DEFAULT_BLOCK_LENGTH = 7;

/**
 * No interval can be claimed without residuals, so the bound is the median and
 * every caller is expected to say so in a warning rather than present it.
 */
const withoutEvidence = (rate: readonly number[]): QuantileBounds => {
  let running = 0;
  const cumulative = rate.map((value) => {
    running += Math.max(0, value);
    return running;
  });
  return { daily: [...rate], cumulative };
};

export function bootstrapQuantiles(
  rate: readonly number[],
  residuals: readonly number[],
  options: BootstrapOptions,
): QuantileBounds {
  if (rate.length === 0) {
    return { daily: [], cumulative: [] };
  }

  if (residuals.length < MINIMUM_RESIDUALS) {
    return withoutEvidence(rate);
  }

  const level = Math.min(0.999, Math.max(0.5, options.level));
  const block = Math.max(
    1,
    Math.min(options.blockLength ?? DEFAULT_BLOCK_LENGTH, residuals.length),
  );
  const blocksNeeded = Math.ceil(rate.length / block);
  const sampler = createSampler(options.seed);

  const daily: number[][] = rate.map(() => []);
  const cumulative: number[][] = rate.map(() => []);

  for (let replication = 0; replication < options.replications; replication += 1) {
    const path: number[] = [];

    for (let index = 0; index < blocksNeeded; index += 1) {
      const start = sampler.index(residuals.length);
      for (let offset = 0; offset < block && path.length < rate.length; offset += 1) {
        const base = rate[path.length] ?? 0;
        const residual = residuals[(start + offset) % residuals.length] ?? 0;
        path.push(Math.max(0, base + residual));
      }
    }

    let running = 0;
    for (let day = 0; day < rate.length; day += 1) {
      const value = path[day] ?? 0;
      running += value;
      daily[day]?.push(value);
      cumulative[day]?.push(running);
    }
  }

  return {
    // Never below the median it was built from: an upper bound under the point
    // estimate would be a contradiction, and the contract forbids it.
    daily: rate.map((base, day) => Math.max(base, quantile(daily[day] ?? [], level))),
    cumulative: rate.map((base, day) => {
      const through = rate
        .slice(0, day + 1)
        .reduce((total, value) => total + Math.max(0, value), 0);
      return Math.max(through, quantile(cumulative[day] ?? [], level), base);
    }),
  };
}
