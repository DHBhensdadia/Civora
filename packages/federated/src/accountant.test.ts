import { describe, expect, it } from 'vitest';

import {
  accountForRounds,
  epsilonPerRound,
  noiseMultiplierForTarget,
  rdpGaussian,
  rdpSampledGaussian,
} from './accountant';

/**
 * The values this file checks against come from published results, cited where
 * they are used:
 *
 *  - Mironov (2017), *Rényi Differential Privacy*, Proposition 3 — the Gaussian
 *    mechanism's RDP is exactly α / (2σ²) at sensitivity one.
 *  - Mironov, Talwar & Zhang (2019), *Rényi Differential Privacy of the Sampled
 *    Gaussian Mechanism*, Table 1 — closed-form bounds for the sampled
 *    mechanism: q²·α/((1−q)σ²) (Abadi et al.), q²·6α/σ² (Bun et al., fixed-size
 *    sampling) and q²·2α/σ² (this work, i.i.d. sampling, q < 1/5 and σ ≥ 4).
 *
 * The implementation evaluates the exact finite sum for integer orders, so the
 * published bounds are upper bounds and the test asserts the computed value sits
 * underneath them — a check the code would fail if the formula were wrong in the
 * direction that flatters the privacy claim.
 */
describe('the Rényi-DP accountant', () => {
  it('computes the Gaussian RDP exactly (Mironov 2017, Prop. 3)', () => {
    expect(rdpGaussian(2, 4)).toBeCloseTo(1 / 16, 15);
    expect(rdpGaussian(32, 8)).toBeCloseTo(32 / 128, 15);
    expect(rdpGaussian(1, 2)).toBeCloseTo(0.125, 15);
  });

  it('reduces the sampled mechanism to the Gaussian when sampling is everything', () => {
    expect(rdpSampledGaussian(16, 1, 4)).toBeCloseTo(rdpGaussian(16, 4), 15);
  });

  it('has the exact order-two value, worked out from the same expansion', () => {
    // D_2 = log(1 + q²(e^{1/σ²} − 1)) for the mixture against the base measure.
    const value = rdpSampledGaussian(2, 0.01, 4);
    expect(value).toBeGreaterThan(6.4e-6);
    expect(value).toBeLessThan(6.5e-6);
    expect(value).toBeCloseTo(6.449e-6, 9);
  });

  it('sits under the published closed-form bounds (Mironov et al. 2019, Table 1)', () => {
    const q = 0.01;
    const alpha = 16;

    // This work's bound: (α, q²·2α/σ²)-RDP for i.i.d. sampling, q < 1/5, σ ≥ 4.
    const sigma = 4;
    const tightBound = (q * q * 2 * alpha) / (sigma * sigma);
    const exact = rdpSampledGaussian(alpha, q, sigma);
    expect(exact).toBeGreaterThan(0);
    expect(exact).toBeLessThanOrEqual(tightBound);

    // Bun et al.'s fixed-size bound: (α, q²·6α/σ²), q ≤ 1/10, σ ≥ √5.
    const bunSigma = 5;
    const bunBound = (q * q * 6 * alpha) / (bunSigma * bunSigma);
    expect(rdpSampledGaussian(alpha, q, bunSigma)).toBeLessThanOrEqual(bunBound);
  });

  it('diminishes quadratically with the sampling rate, as the paper states', () => {
    const alpha = 16;
    const sigma = 4;
    const larger = rdpSampledGaussian(alpha, 0.01, sigma) / 0.01 ** 2;
    const smaller = rdpSampledGaussian(alpha, 0.005, sigma) / 0.005 ** 2;
    // The ratio is the same to within a couple of percent: the cost is quadratic
    // in q, not linear, which is the amplification-by-sampling claim itself.
    expect(Math.abs(larger / smaller - 1)).toBeLessThan(0.02);
  });

  it('is monotone in the noise multiplier and in the sampling rate', () => {
    expect(rdpSampledGaussian(8, 0.05, 8)).toBeLessThan(rdpSampledGaussian(8, 0.05, 4));
    expect(rdpSampledGaussian(8, 0.02, 4)).toBeGreaterThan(rdpSampledGaussian(8, 0.01, 4));
  });

  it('refuses an order it cannot price and an unbounded mechanism', () => {
    expect(() => rdpSampledGaussian(1.5, 0.01, 4)).toThrow(/integer/);
    expect(() => rdpSampledGaussian(1, 0.01, 4)).toThrow(/at least two/);
    expect(() => rdpSampledGaussian(8, 0.01, 0)).toThrow(/positive/);
  });

  it('spends nothing before the first round and rises with every one', () => {
    const options = { rounds: 4, samplingRate: 0.5, noiseMultiplier: 2, delta: 1e-5 };
    expect(accountForRounds({ ...options, rounds: 0 }).epsilon).toBe(0);
    const perRound = epsilonPerRound(options);
    expect(perRound[0]).toBeGreaterThan(0);
    for (let index = 1; index < perRound.length; index += 1) {
      expect(perRound[index]).toBeGreaterThan(perRound[index - 1] ?? 0);
    }
    expect(accountForRounds(options).epsilon).toBeCloseTo(perRound[3] ?? 0, 12);
  });

  it('reports the conversion at the best order and respects δ', () => {
    const strict = accountForRounds({
      rounds: 10,
      samplingRate: 0.5,
      noiseMultiplier: 4,
      delta: 1e-7,
    });
    const loose = accountForRounds({
      rounds: 10,
      samplingRate: 0.5,
      noiseMultiplier: 4,
      delta: 1e-3,
    });
    expect(strict.epsilon).toBeGreaterThan(loose.epsilon);
    expect(strict.bestOrder).toBeGreaterThanOrEqual(2);
    expect(strict.rdp).toBeGreaterThan(0);
    // The conversion's own arithmetic, checked directly.
    expect(strict.epsilon).toBeCloseTo(
      strict.rdp + Math.log(1 / 1e-7) / (strict.bestOrder - 1),
      12,
    );
  });

  it('finds the noise multiplier a target ε costs, and the answer round-trips', () => {
    const target = 2;
    const sigma = noiseMultiplierForTarget({
      epsilon: target,
      delta: 1e-5,
      rounds: 10,
      samplingRate: 0.5,
    });
    const spend = accountForRounds({
      rounds: 10,
      samplingRate: 0.5,
      noiseMultiplier: sigma,
      delta: 1e-5,
    });
    expect(spend.epsilon).toBeLessThanOrEqual(target);
    expect(spend.epsilon).toBeGreaterThan(target - 0.05);
    expect(sigma).toBeGreaterThan(0);
  });

  it('says so when the target is out of reach rather than returning a wrong number', () => {
    expect(() =>
      noiseMultiplierForTarget({ epsilon: 1e-9, delta: 1e-12, rounds: 1000, samplingRate: 1 }),
    ).toThrow(/even a noise multiplier/);
  });
});
