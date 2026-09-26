import { describe, expect, it } from 'vitest';

import {
  clipVector,
  linearShape,
  meanSquaredError,
  mlpShape,
  parameterCount,
  predict,
  sampleGradient,
  vectorNorm,
  zeroParameters,
} from './model';
import { gaussian, sampleDistinct, seededRng, shuffled, streamFor } from './rng';

const squaredError = (
  shape: ReturnType<typeof linearShape>,
  parameters: readonly number[],
  features: readonly number[],
  target: number,
): number => (predict(shape, parameters, features) - target) ** 2;

describe('the differentiable model', () => {
  it('has a parameter for every weight and bias', () => {
    expect(parameterCount(linearShape(3))).toBe(4);
    expect(parameterCount(mlpShape(3, 4))).toBe(4 * (3 + 1) + 4 + 1);
  });

  it('predicts zero from the origin', () => {
    expect(predict(linearShape(2), zeroParameters(linearShape(2)), [1, 2])).toBe(0);
    expect(predict(mlpShape(2, 3), zeroParameters(mlpShape(2, 3)), [1, 2])).toBe(0);
  });

  it('matches a finite difference for the linear gradient', () => {
    const shape = linearShape(3);
    const parameters = [0.2, -0.4, 0.1, 0.05];
    const features = [1.5, -2, 0.5];
    const target = 1.2;
    const gradient = sampleGradient(shape, parameters, features, target);
    const step = 1e-6;

    for (let index = 0; index < parameters.length; index += 1) {
      const up = [...parameters];
      const down = [...parameters];
      up[index] = (up[index] ?? 0) + step;
      down[index] = (down[index] ?? 0) - step;
      const numeric =
        (squaredError(shape, up, features, target) - squaredError(shape, down, features, target)) /
        (2 * step);
      expect(gradient[index]).toBeCloseTo(numeric, 6);
    }
  });

  it('matches a finite difference for the MLP gradient', () => {
    const shape = mlpShape(3, 4);
    const parameters = Array.from(
      { length: parameterCount(shape) },
      (_unused, index) => ((index % 7) - 3) / 10,
    );
    const features = [1.5, -2, 0.5];
    const target = 0.8;
    const gradient = sampleGradient(shape, parameters, features, target);
    const step = 1e-6;

    for (let index = 0; index < parameters.length; index += 1) {
      const up = [...parameters];
      const down = [...parameters];
      up[index] = (up[index] ?? 0) + step;
      down[index] = (down[index] ?? 0) - step;
      const numeric =
        (squaredError(shape, up, features, target) - squaredError(shape, down, features, target)) /
        (2 * step);
      expect(gradient[index]).toBeCloseTo(numeric, 6);
    }
  });

  it('clips a long vector to the norm and leaves a short one alone', () => {
    const long = [3, 4];
    const clipped = clipVector(long, 1);
    expect(vectorNorm(clipped)).toBeCloseTo(1, 12);
    // Direction preserved: the clipped vector is a positive multiple.
    expect((clipped[0] ?? 0) / 3).toBeCloseTo((clipped[1] ?? 0) / 4, 12);

    const short = [0.1, 0.1];
    expect(clipVector(short, 1)).toEqual(short);
    expect(clipVector([], 1)).toEqual([]);
    expect(clipVector(long, Number.POSITIVE_INFINITY)).toEqual(long);
  });

  it('scores mean squared error over a sample set', () => {
    const shape = linearShape(1);
    // prediction = 2x + 1, so these three targets are fitted exactly.
    const parameters = [2, 1];
    expect(
      meanSquaredError(shape, parameters, [
        { features: [1], target: 3 },
        { features: [2], target: 5 },
        { features: [3], target: 7 },
      ]),
    ).toBe(0);
    // Each target one past the last example's: errors are 1, 2 and 4, so the
    // mean square is (1 + 4 + 16) / 3.
    expect(
      meanSquaredError(shape, parameters, [
        { features: [1], target: 4 },
        { features: [2], target: 7 },
        { features: [3], target: 11 },
      ]),
    ).toBeCloseTo((1 + 4 + 16) / 3, 12);
  });
});

describe('the seeded streams', () => {
  it('reproduces the same sequence for the same seed and purpose', () => {
    const first = Array.from({ length: 5 }, () => seededRng('a')());
    const again = Array.from({ length: 5 }, () => seededRng('a')());
    expect(first).toEqual(again);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('separates the streams by purpose and by seed', () => {
    const values = Array.from({ length: 4 }, () => streamFor('s', 'one')());
    const others = Array.from({ length: 4 }, () => streamFor('s', 'two')());
    expect(values).not.toEqual(others);
    expect(streamFor('s', 'one')()).not.toBe(streamFor('t', 'one')());
  });

  it('draws distinct indices within range', () => {
    const drawn = sampleDistinct(seededRng('draw'), 10, 4);
    expect(drawn).toHaveLength(4);
    expect(new Set(drawn).size).toBe(4);
    expect(drawn.every((index) => index >= 0 && index < 10)).toBe(true);
    expect(sampleDistinct(seededRng('draw'), 3, 10)).toHaveLength(3);
  });

  it('shuffles deterministically and without mutating the input', () => {
    const input = [1, 2, 3, 4, 5];
    const first = shuffled(seededRng('shuffle'), input);
    const again = shuffled(seededRng('shuffle'), input);
    expect(first).toEqual(again);
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect([...first].sort((left, right) => left - right)).toEqual(input);
  });

  it('draws finite Gaussian values with the requested scale', () => {
    const draw = seededRng('gaussian');
    const values = Array.from({ length: 200 }, () => gaussian(draw));
    expect(values.every((value) => Number.isFinite(value))).toBe(true);
    // A loose sanity band: the mean of 200 standard normals is near zero.
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    expect(Math.abs(mean)).toBeLessThan(0.3);
  });
});
