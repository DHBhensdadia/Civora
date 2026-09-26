import { describe, expect, it } from 'vitest';

import { linearShape, meanSquaredError, predict } from './model';
import { siloStandardisation, standardisedSamples, trainLocally } from './local';
import { poolFeatureScale, featureScaleOf } from './scaling';
import type { FederatedSample } from './types';

// y = 3 x1 + 2 x2, exactly learnable, so "did it learn" is not a judgement call.
// Both features are strictly positive: a sample at the origin has a zero target
// and a zero gradient, and a clip cannot shorten a zero vector — which would
// make the clip test a statement about the fixture rather than about the clip.
const learnable = (): readonly FederatedSample[] =>
  Array.from({ length: 64 }, (_unused, index) => {
    const first = ((index % 8) + 1) / 4;
    const second = (Math.floor(index / 8) + 1) / 4;
    return { features: [first, second], target: 3 * first + 2 * second };
  });

const shape = linearShape(2);

describe('silo-local training', () => {
  it('reduces the loss on a learnable series and reports both ends', () => {
    const result = trainLocally({
      shape,
      global: [0, 0, 0],
      samples: learnable(),
      // No basis is given, so the weights the model finds are the weights in the
      // series — y = 3x₁ + 2x₂ — and the two ends are measured on the same rows
      // the model was fitted on. Adam rather than SGD because the claim is that
      // the loop learns at all, not that one optimiser beats another.
      options: {
        seed: 's',
        epochs: 40,
        batchSize: 16,
        learningRate: 0.05,
        optimizer: 'adam',
        mu: 0,
        l2: 0,
      },
    });
    expect(result.firstLoss).toBeGreaterThan(result.lastLoss);
    expect(result.lastLoss).toBeLessThan(result.firstLoss / 20);
    expect(result.steps).toBe(40 * 4);
    expect(result.parameters[0]).toBeCloseTo(3, 1);
    expect(result.parameters[1]).toBeCloseTo(2, 1);
  });

  it('is a pure function of its seed', () => {
    const options = {
      seed: 'fixed',
      epochs: 4,
      batchSize: 16,
      learningRate: 0.05,
      optimizer: 'adam' as const,
      mu: 0.05,
      l2: 0.0001,
    };
    const first = trainLocally({ shape, global: [0, 0, 0], samples: learnable(), options });
    const again = trainLocally({ shape, global: [0, 0, 0], samples: learnable(), options });
    expect(again.parameters).toEqual(first.parameters);
    expect(again.update).toEqual(first.update);
    expect(again.lastLoss).toBe(first.lastLoss);
  });

  it('pulls the update towards the global model as the proximal weight rises', () => {
    // The proximal term's steps are `learningRate · mu` in size, so a weight of
    // 50 against a rate of 0.2 contracts by a factor of 10 per step and diverges
    // — the parameterisation has to be stable before it can be compared. With
    // 0.01 · 5 the contraction is 0.05 per step and both runs stay finite.
    const base = {
      seed: 'mu',
      epochs: 3,
      batchSize: 16,
      learningRate: 0.01,
      optimizer: 'sgd' as const,
      l2: 0,
    };
    const loose = trainLocally({
      shape,
      global: [0, 0, 0],
      samples: learnable(),
      options: { ...base, mu: 0 },
    });
    const held = trainLocally({
      shape,
      global: [0, 0, 0],
      samples: learnable(),
      options: { ...base, mu: 5 },
    });
    const norm = (values: readonly number[]): number =>
      Math.sqrt(values.reduce((total, value) => total + value * value, 0));
    expect(norm(loose.update)).toBeGreaterThan(0);
    expect(norm(held.update)).toBeLessThan(norm(loose.update));
  });

  it('reports how often the per-sample clip bit', () => {
    const samples = learnable();
    // SGD, deliberately. Under Adam a gradient that has been scaled to 1e-9 is
    // re-normalised to a full learning-rate step, so the clip's effect on the
    // update's size would be invisible; under SGD the step is proportional to
    // the gradient, which is the thing the clip bounds.
    const options = {
      seed: 'clip',
      epochs: 1,
      batchSize: 16,
      learningRate: 0.05,
      optimizer: 'sgd' as const,
      mu: 0,
      l2: 0,
    };
    const never = trainLocally({
      shape,
      global: [0, 0, 0],
      samples,
      options: { ...options, clipNorm: 1e9 },
    });
    const always = trainLocally({
      shape,
      global: [0, 0, 0],
      samples,
      options: { ...options, clipNorm: 1e-9 },
    });
    expect(never.clippedFraction).toBe(0);
    expect(always.clippedFraction).toBe(1);
    // A hard clip leaves almost nothing behind: every gradient is scaled to
    // norm 1e-9, so four steps move the model by ~1e-10.
    const norm = (values: readonly number[]): number =>
      Math.sqrt(values.reduce((total, value) => total + value * value, 0));
    expect(norm(always.update)).toBeLessThan(1e-6);
    expect(norm(never.update)).toBeGreaterThan(0.01);
  });

  it('trains in the shared basis it is given, and says so', () => {
    const samples = learnable();
    // The basis a federation would agree from pooled sums and counts. Taken from
    // two silos here so the pooling path is exercised, not bypassed.
    const half = Math.floor(samples.length / 2);
    const shared = poolFeatureScale([
      featureScaleOf(samples.slice(0, half)),
      featureScaleOf(samples.slice(half)),
    ]);

    const result = trainLocally({
      shape,
      global: [0, 0, 0],
      samples,
      options: {
        seed: 'shared-basis',
        epochs: 40,
        batchSize: 16,
        learningRate: 0.05,
        optimizer: 'adam',
        mu: 0,
        l2: 0,
        standardisation: shared,
      },
    });

    // The rows the model was fitted on are the shared basis's rows, and the loss
    // is measured on those rows — any other measurement would be a model in one
    // space scored in another.
    const rows = standardisedSamples(samples, shared);
    expect(result.lastLoss).toBeCloseTo(meanSquaredError(shape, result.parameters, rows), 12);
    expect(result.lastLoss).toBeLessThan(result.firstLoss / 20);
    expect(result.standardisation).toEqual(shared);
    // The update is the change in that basis, so re-adding it to the model the
    // silo started from reproduces what it trained, exactly.
    for (let index = 0; index < result.parameters.length; index += 1) {
      expect((result.update[index] ?? 0) + 0).toBeCloseTo(result.parameters[index] ?? 0, 12);
    }
    // And the same function on raw features is what the model actually is: the
    // shared basis is a re-parameterisation, not extra data.
    const asRawFunction = (row: readonly number[]): number =>
      predict(
        shape,
        result.parameters,
        row.map((value, index) => (value - (shared.mean[index] ?? 0)) / (shared.scale[index] ?? 1)),
      );
    expect(asRawFunction(samples[0]?.features ?? [])).toBeCloseTo(
      predict(shape, result.parameters, rows[0]?.features ?? []),
      12,
    );
  });

  it('standardises with the silo’s own statistics and nothing else', () => {
    const samples: readonly FederatedSample[] = [
      { features: [10, 1], target: 4 },
      { features: [20, 3], target: 1 },
      { features: [30, 5], target: 1 },
    ];
    const statistics = siloStandardisation(samples);
    expect(statistics.mean[0]).toBeCloseTo(20, 12);
    expect(statistics.mean[1]).toBeCloseTo(3, 12);
    // Sample spread: sqrt(((10²+0+10²)/3)) = sqrt(200/3) ≈ 8.165.
    expect(statistics.scale[0]).toBeCloseTo(Math.sqrt(200 / 3), 6);
    expect(statistics.scale[1]).toBeCloseTo(Math.sqrt(8 / 3), 6);

    // The target is standardised with the same function, over the same rows: mean
    // 2, spread sqrt(((4+1+1)/3)) = sqrt(2).
    expect(statistics.targetMean).toBeCloseTo(2, 12);
    expect(statistics.targetScale).toBeCloseTo(Math.sqrt(2), 6);

    const targets = standardisedSamples(samples, statistics).map((sample) => sample.target);
    expect(targets[0]).toBeCloseTo(2 / Math.sqrt(2), 12);
    expect(targets[1]).toBeCloseTo(-1 / Math.sqrt(2), 12);
    const mean = targets.reduce((total, value) => total + value, 0) / targets.length;
    const variance =
      targets.reduce((total, value) => total + (value - mean) ** 2, 0) / targets.length;
    expect(Math.abs(mean)).toBeLessThan(1e-12);
    expect(variance).toBeCloseTo(1, 10);
  });

  it('leaves a constant feature, and a constant target, alone rather than dividing by zero', () => {
    const samples: readonly FederatedSample[] = [
      { features: [5], target: 1 },
      { features: [5], target: 2 },
    ];
    const statistics = siloStandardisation(samples);
    expect(statistics.scale[0]).toBe(1);
    expect(statistics.mean[0]).toBe(5);
    expect(statistics.targetScale).not.toBe(0);

    const flat = siloStandardisation([{ features: [5], target: 7 }]);
    expect(flat.targetScale).toBe(1);
    expect(flat.targetMean).toBe(7);
  });
});
