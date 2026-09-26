import { describe, expect, it } from 'vitest';

import { siloStandardisation, standardisedSamples } from './local';
import {
  ALLOWED_SCALE_FIELDS,
  featureScaleOf,
  inspectScalePayload,
  poolFeatureScale,
  scalePayloadOf,
} from './scaling';
import type { FederatedSample, SiloStandardisation } from './types';

const rows = (count: number): readonly FederatedSample[] =>
  Array.from({ length: count }, (_unused, index) => ({
    features: [10 + (index % 7), index / 3, 5],
    target: 1,
  }));

/**
 * The shared basis is the federation's own normalisation, so it has to survive
 * the same scrutiny as the update payload: pooled statistics must equal what the
 * whole population would have said, and the payload that carries them must carry
 * sums and counts and nothing else.
 */
describe('the shared feature basis', () => {
  it('pools silos’ sums into exactly what the whole population would say', () => {
    const all = rows(60);
    const halves = [all.slice(0, 17), all.slice(17, 41), all.slice(41)];

    const pooled = poolFeatureScale(halves.map((part) => featureScaleOf(part)));
    const whole = siloStandardisation(all);

    for (let index = 0; index < whole.mean.length; index += 1) {
      expect(pooled.mean[index]).toBeCloseTo(whole.mean[index] ?? 0, 10);
      expect(pooled.scale[index]).toBeCloseTo(whole.scale[index] ?? 0, 10);
    }
    // Three parts, so the shares are unequal and the weighting is exercised.
    expect(halves.map((part) => part.length)).toEqual([17, 24, 19]);
  });

  it('pools the target with the features, so the loss has a shared unit', () => {
    // Targets that vary, unlike the rows above: a target that never moves has no
    // spread, and `1` as a scale would make the loss unreadable for the wrong
    // reason (nothing was learned from it) rather than the right one.
    const varying = (count: number): readonly FederatedSample[] =>
      Array.from({ length: count }, (_unused, index) => ({
        features: [index / 3],
        target: index % 5,
      }));
    const all = varying(40);
    const pooled = poolFeatureScale([
      featureScaleOf(all.slice(0, 13)),
      featureScaleOf(all.slice(13)),
    ]);
    const whole = siloStandardisation(all);

    expect(pooled.targetMean).toBeCloseTo(whole.targetMean, 10);
    expect(pooled.targetScale).toBeCloseTo(whole.targetScale, 10);
    // Standardising the target is what puts the optimal weights at order one; the
    // assertion that the whole federation agrees on one scale is the assertion
    // that the pooling path carries it.
    const standardised = standardisedSamples(all, pooled).map((sample) => sample.target);
    const mean = standardised.reduce((total, value) => total + value, 0) / standardised.length;
    const variance =
      standardised.reduce((total, value) => total + (value - mean) ** 2, 0) / standardised.length;
    expect(Math.abs(mean)).toBeLessThan(1e-12);
    expect(variance).toBeCloseTo(1, 10);
  });

  it('sums the rows, and leaves a feature that never varies alone', () => {
    const all = rows(4);
    const whole = featureScaleOf(all);
    expect(whole.count).toBe(4);
    expect(whole.sums[0]).toBe(10 + 11 + 12 + 13);
    expect(whole.squares[0]).toBe(100 + 121 + 144 + 169);

    // One row per part, pooled: exactly what the whole set gives, which is what
    // lets each silo sum its own rows and share only the sums.
    const pooled = poolFeatureScale(all.map((row) => featureScaleOf([row])));
    expect(pooled.mean[0]).toBeCloseTo(whole.sums[0] === undefined ? 0 : whole.sums[0] / 4, 12);
    // The third feature is 5 on every row: centred, never divided by zero.
    expect(pooled.mean[2]).toBeCloseTo(5, 12);
    expect(pooled.scale[2]).toBe(1);
  });

  it('answers a scale for an empty federation rather than throwing', () => {
    const pooled: SiloStandardisation = poolFeatureScale([]);
    expect(pooled.mean).toEqual([]);
    expect(pooled.scale).toEqual([]);
    expect(pooled.targetMean).toBe(0);
    // A scale of zero would divide every target by nothing; `1` leaves a
    // federation with no rows describing an untransformed target.
    expect(pooled.targetScale).toBe(1);
  });

  it('carries sums and counts for the target too, and refuses anything else', () => {
    const payload = scalePayloadOf('SIM-ODI', rows(10));
    expect(payload.targetSum).toBe(10);
    expect(payload.targetSquares).toBe(10);
    const brokenTarget = { ...payload, targetSum: Number.POSITIVE_INFINITY } as typeof payload;
    expect(
      inspectScalePayload(brokenTarget).findings.some((finding) => finding.includes('targetSum')),
    ).toBe(true);
  });

  it('carries sums and counts, and refuses anything else', () => {
    const payload = scalePayloadOf('SIM-ODI', rows(10));
    expect(Object.keys(payload).sort()).toEqual([...ALLOWED_SCALE_FIELDS].sort());
    expect(inspectScalePayload(payload).ok).toBe(true);

    const smuggled = {
      ...payload,
      sampleRows: [{ facilityId: 'SIM-BIHAR-GAYA-B1-CHC-03' }],
    } as unknown as typeof payload;
    const found = inspectScalePayload(smuggled, ['SIM-BIHAR-GAYA-B1-CHC-03']);
    expect(found.ok).toBe(false);
    expect(found.findings.some((finding) => finding.includes('unexpected field'))).toBe(true);
    expect(found.findings.some((finding) => finding.includes('sentinel'))).toBe(true);

    const broken = { ...payload, sums: [Number.NaN] } as typeof payload;
    expect(inspectScalePayload(broken).findings.some((f) => f.includes('finite number'))).toBe(
      true,
    );
    const negative = { ...payload, count: -1 } as typeof payload;
    expect(inspectScalePayload(negative).findings.some((f) => f.includes('count'))).toBe(true);
  });

  it('cannot carry a record identifier, because every field it has is a number', () => {
    const payload = scalePayloadOf('SIM-ODI', rows(5));
    const serialised = JSON.stringify(payload);
    // A facility, an item, a batch and a date: none of them is a number, and the
    // payload has nowhere to put one — which the sentinel scan then confirms.
    for (const sentinel of ['CHC-03', 'nlem-15-1-furosemide', 'BATCH-7f3a-9911', '2026-03-01']) {
      expect(serialised.includes(sentinel)).toBe(false);
    }
    expect(inspectScalePayload(payload, ['CHC-03', '2026-03-01']).findings).toEqual([]);
  });
});
