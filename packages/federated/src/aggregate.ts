import { clipVector, vectorNorm } from './model';
import type { SiloUpdate } from './types';

/**
 * The coordinator's arithmetic, and the one place clipping happens.
 *
 * Weighted federated averaging is `Σ_k (n_k / n) Δ_k`: a silo with more history
 * moves the model further. Two details make the privacy claim exact rather than
 * approximate:
 *
 *  - **Clipping happens before weighting.** Each silo's update is scaled down to
 *    the stated norm `C` first; the largest weight any silo can carry is then
 *    `w_max`, so one silo's contribution to the weighted sum is at most
 *    `C · w_max`. That product is the sensitivity the Gaussian noise is
 *    calibrated to, and the accountant's `σ` is the multiplier *relative to it*.
 *  - **The weighted updates are what get masked.** Scaling before masking means
 *    the mask cancels in the weighted sum exactly as it would in an unweighted
 *    one, so secure aggregation composes with weighted averaging instead of
 *    forcing the coordinator to see individual updates to weight them.
 */

export interface WeightedUpdates {
  /** One update per participant, clipped and scaled by its sample weight. */
  readonly weighted: readonly SiloUpdate[];
  readonly clippedSilos: number;
  /** The largest sample weight in the round; the sensitivity's multiplier. */
  readonly maxWeight: number;
  readonly totalSamples: number;
  readonly largestRawNorm: number;
}

export function clipAndWeight(updates: readonly SiloUpdate[], clipNorm: number): WeightedUpdates {
  const totalSamples = updates.reduce((total, entry) => total + entry.sampleCount, 0);
  let clippedSilos = 0;
  let largestRawNorm = 0;
  let maxWeight = 0;

  const weighted = updates.map((entry) => {
    const rawNorm = vectorNorm(entry.update);
    largestRawNorm = Math.max(largestRawNorm, rawNorm);
    const clipped = clipVector(entry.update, clipNorm);
    if (vectorNorm(clipped) < rawNorm) {
      clippedSilos += 1;
    }
    const weight = totalSamples === 0 ? 0 : entry.sampleCount / totalSamples;
    maxWeight = Math.max(maxWeight, weight);
    return {
      siloId: entry.siloId,
      sampleCount: entry.sampleCount,
      localLoss: entry.localLoss,
      update: clipped.map((value) => value * weight),
    };
  });

  return { weighted, clippedSilos, maxWeight, totalSamples, largestRawNorm };
}

/** Element-wise sum over updates, whoever computed them. */
export function sumUpdates(updates: readonly SiloUpdate[]): readonly number[] {
  const width = updates[0]?.update.length ?? 0;
  const total = new Array<number>(width).fill(0);
  for (const entry of updates) {
    for (let index = 0; index < width; index += 1) {
      total[index] = (total[index] ?? 0) + (entry.update[index] ?? 0);
    }
  }
  return total;
}

/**
 * How far apart the silos' updates are, as one number between 0 and 1.
 *
 * This is the non-IID diagnostic the console shows: zero means every
 * participant proposed the same direction, and values near one mean their
 * proposals barely overlap — which is the situation FedProx exists for. It can
 * only be computed when the coordinator can see individual updates; under
 * masking it reports `null` rather than a number it does not have.
 */
export function updateDivergence(updates: readonly SiloUpdate[]): number | null {
  if (updates.length < 2) {
    return 0;
  }
  const totalSamples = updates.reduce((total, entry) => total + entry.sampleCount, 0);
  const width = updates[0]?.update.length ?? 0;
  const mean = new Array<number>(width).fill(0);
  for (const entry of updates) {
    const weight = totalSamples === 0 ? 0 : entry.sampleCount / totalSamples;
    for (let index = 0; index < width; index += 1) {
      mean[index] = (mean[index] ?? 0) + (entry.update[index] ?? 0) * weight;
    }
  }

  let spread = 0;
  let scale = 0;
  for (const entry of updates) {
    const weight = totalSamples === 0 ? 0 : entry.sampleCount / totalSamples;
    for (let index = 0; index < width; index += 1) {
      spread += weight * ((entry.update[index] ?? 0) - (mean[index] ?? 0)) ** 2;
      scale += weight * (entry.update[index] ?? 0) ** 2;
    }
  }
  if (scale === 0) {
    return 0;
  }
  return Math.min(1, spread / scale);
}

/**
 * Add calibrated Gaussian noise to a vector, one draw per coordinate.
 *
 * The draw is a **standard normal**, and the caller supplies it so that the
 * stream is explicit. That matters more than it looks: an earlier version of this
 * function was handed the raw uniform stream and multiplied it by σ, which makes
 * the noise `σ · U[0,1)` — a shift whose mean is `+σ/2` and whose spread is
 * `σ/√12`, not `N(0, σ²)`. Two things are wrong with that, and only one of them
 * is statistical. The accountant prices a Gaussian, so the ε a run reports would
 * not have described the mechanism it actually ran; and a systematic positive
 * drift is a *training* signal, which is how the defect was caught: the noisiest
 * run in a sweep was the one that improved most, while the noise-free run got
 * worse. `aggregate.test.ts` now holds the mean and the spread of what this
 * function adds.
 */
export function addGaussianNoise(
  values: readonly number[],
  standardDeviation: number,
  normal: () => number,
): readonly number[] {
  if (standardDeviation <= 0) {
    return values;
  }
  return values.map((value) => value + standardDeviation * normal());
}

/** The bytes an update occupies, reported per round rather than estimated. */
export const bytesOf = (values: readonly number[]): number => values.length * 8;
