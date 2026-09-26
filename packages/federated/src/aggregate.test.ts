import { describe, expect, it } from 'vitest';

import {
  addGaussianNoise,
  bytesOf,
  clipAndWeight,
  sumUpdates,
  updateDivergence,
} from './aggregate';
import { vectorNorm } from './model';
import { gaussian, seededRng, streamFor } from './rng';
import type { SiloUpdate } from './types';

// Four silos with unequal row counts, so every weight is distinct and a
// weighting bug cannot hide behind a symmetry.
const updates: readonly SiloUpdate[] = [
  { siloId: 'SIM-A', sampleCount: 600, update: [3, 4], localLoss: 1 },
  { siloId: 'SIM-B', sampleCount: 240, update: [0.1, -0.2], localLoss: 2 },
  { siloId: 'SIM-C', sampleCount: 120, update: [-5, 0], localLoss: 3 },
  { siloId: 'SIM-D', sampleCount: 40, update: [0.05, 0.05], localLoss: 4 },
];

describe('the coordinator’s arithmetic', () => {
  it('clips each update before it is weighted, so no silo can exceed its share', () => {
    const clipNorm = 1;
    const { weighted, clippedSilos, maxWeight, largestRawNorm, totalSamples } = clipAndWeight(
      updates,
      clipNorm,
    );

    expect(totalSamples).toBe(1000);
    // Two of the four are outside the clip (‖(3, 4)‖ = 5 and ‖(−5, 0)‖ = 5) and
    // the other two are inside it (‖(0.1, −0.2)‖ ≈ 0.224, ‖(0.05, 0.05)‖ ≈ 0.071),
    // so the counter has to say two: it is a count of what the clip shortened,
    // not of how many updates were weighted.
    expect(clippedSilos).toBe(2);
    expect(largestRawNorm).toBeCloseTo(5, 12);

    for (const [index, entry] of weighted.entries()) {
      const source = updates[index];
      const weight = (source?.sampleCount ?? 0) / totalSamples;
      expect(weight).toBeCloseTo(entry.sampleCount / totalSamples, 12);
      expect(vectorNorm(entry.update)).toBeLessThanOrEqual(clipNorm * weight + 1e-12);
      // Direction survives the clip: the weighted update is the raw one scaled.
      const first = source?.update[0] ?? 0;
      const second = source?.update[1] ?? 0;
      const rawNorm = Math.sqrt(first * first + second * second);
      const factor = rawNorm > clipNorm ? (clipNorm / rawNorm) * weight : weight;
      expect(entry.update[0]).toBeCloseTo(first * factor, 12);
      expect(entry.update[1]).toBeCloseTo(second * factor, 12);
    }

    // The largest share is the quantity the noise is calibrated to, so it must be
    // the weight of the silo that holds the most rows — not the largest row count
    // divided by something that is not the total.
    expect(maxWeight).toBeCloseTo(600 / 1000, 12);
  });

  it('sums element-wise over updates, whoever computed them', () => {
    expect(sumUpdates(updates)).toEqual([3 + 0.1 - 5 + 0.05, 4 - 0.2 + 0 + 0.05]);
    expect(sumUpdates([])).toEqual([]);
  });

  it('measures how far apart the silos’ proposals are', () => {
    // Identical proposals: no divergence, which is what a federation of like
    // silos looks like — and 0 is a measurement, not an absent value.
    const same: readonly SiloUpdate[] = [
      { siloId: 'SIM-A', sampleCount: 1, update: [1, 0], localLoss: 1 },
      { siloId: 'SIM-B', sampleCount: 1, update: [1, 0], localLoss: 1 },
    ];
    expect(updateDivergence(same)).toBeCloseTo(0, 12);

    // Opposite proposals: the spread is as large as the total magnitude, so this
    // is the top of the scale, and it is reported rather than clamped away.
    const opposed: readonly SiloUpdate[] = [
      { siloId: 'SIM-A', sampleCount: 1, update: [1, 0], localLoss: 1 },
      { siloId: 'SIM-B', sampleCount: 1, update: [-1, 0], localLoss: 1 },
    ];
    expect(updateDivergence(opposed)).toBeCloseTo(1, 12);

    // One participant cannot be spread out, and an empty round has no opinion.
    expect(updateDivergence([same[0]!])).toBe(0);
    expect(updateDivergence([])).toBe(0);
  });

  it('reports an update’s size in bytes from the vector itself', () => {
    expect(bytesOf([1, 2, 3])).toBe(24);
    expect(bytesOf([])).toBe(0);
  });

  /**
   * The assertion that would have caught the defect this file exists for.
   *
   * The noise is priced by the accountant as `N(0, σ²)` per coordinate. It was
   * being drawn from the raw uniform stream and multiplied by σ, which is
   * `σ · U[0,1)`: mean `+σ/2`, spread `σ/√12`, and no negative values at all.
   * The first two assertions below fail for that mechanism — the mean band
   * because the shift is systematic, and the sign assertion because half of a
   * normal's mass is below zero and none of a uniform's is. The third is there
   * because a constant is neither: a mechanism that added `+σ` to every
   * coordinate would pass a naive "has spread" check while being exactly the
   * drift that made the noisiest run in a sweep the best-performing one.
   */
  it('adds noise with the mean and the spread it was asked for', () => {
    const standardDeviation = 2.5;
    const draw = streamFor('noise-test', 'coordinates');
    const values = new Array<number>(20_000).fill(0);
    const noised = addGaussianNoise(values, standardDeviation, () => gaussian(draw));

    const mean = noised.reduce((total, value) => total + value, 0) / noised.length;
    const variance =
      noised.reduce((total, value) => total + (value - mean) ** 2, 0) / noised.length;
    const spread = Math.sqrt(variance);
    const negative = noised.filter((value) => value < 0).length;
    const beyondHalf = noised.filter((value) => Math.abs(value) > standardDeviation).length;

    // 20,000 draws: the standard error of the mean is σ/√20000 ≈ 0.018, so a band
    // of 0.05 is generous for a correct draw and far too tight for a `+σ/2` shift.
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(spread).toBeGreaterThan(standardDeviation * 0.95);
    expect(spread).toBeLessThan(standardDeviation * 1.05);
    // ~31.7% of a standard normal lies outside ±1σ, and ~50% below zero.
    expect(beyondHalf / noised.length).toBeGreaterThan(0.28);
    expect(negative / noised.length).toBeGreaterThan(0.46);
    expect(negative / noised.length).toBeLessThan(0.54);
  });

  it('leaves the values alone when there is no mechanism', () => {
    const values = [1, -2, 3];
    expect(addGaussianNoise(values, 0, () => gaussian(seededRng('unused')))).toBe(values);
  });
});
