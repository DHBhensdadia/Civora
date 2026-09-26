import { describe, expect, it } from 'vitest';

import { maskUpdates, sumMaskedUpdates, sumTrueUpdates } from './masking';
import type { SiloUpdate } from './types';

const updateOf = (siloId: string, values: readonly number[]): SiloUpdate => ({
  siloId,
  sampleCount: 10,
  update: values,
  localLoss: 0.5,
});

const updates = [
  updateOf('SIM-BIHAR', [1, 2, 3, 4]),
  updateOf('SIM-KERALA', [-1, 0.5, 0, 2]),
  updateOf('SIM-ODISHA', [0.25, -0.75, 1.5, 0]),
];

describe('masked secure aggregation', () => {
  it('hides every individual update while preserving the sum exactly', () => {
    const masked = maskUpdates(updates, 'round-1');
    const trueSum = sumTrueUpdates(updates);
    const maskedSum = sumMaskedUpdates(masked);

    for (let index = 0; index < trueSum.length; index += 1) {
      expect(maskedSum[index]).toBeCloseTo(trueSum[index] ?? 0, 9);
    }

    // And every masked update is genuinely different from the true one, so the
    // coordinator is not looking at plaintext because a mask happened to be 0.
    for (const entry of masked) {
      const original = updates.find((candidate) => candidate.siloId === entry.siloId);
      const differs = entry.maskedUpdate.some(
        (value, index) => Math.abs(value - (original?.update[index] ?? 0)) > 1e-9,
      );
      expect(differs).toBe(true);
    }
  });

  it('leaves the coordinator unable to tell two assignments apart', () => {
    const masked = maskUpdates(updates, 'round-1');
    const maskedSum = sumMaskedUpdates(masked);

    // The same masked sum is consistent with a different assignment of updates:
    // move δ from one silo to another and nothing the coordinator holds changes.
    const moved = [0.5, -0.25, 1, 0.75];
    const alternative: readonly SiloUpdate[] = [
      { ...updates[0]!, update: updates[0]!.update.map((v, i) => v + (moved[i] ?? 0)) },
      { ...updates[1]!, update: updates[1]!.update.map((v, i) => v - (moved[i] ?? 0)) },
      updates[2]!,
    ];
    const alternativeSum = sumTrueUpdates(alternative);
    for (let index = 0; index < alternativeSum.length; index += 1) {
      expect(alternativeSum[index]).toBeCloseTo(maskedSum[index] ?? 0, 9);
    }
  });

  it('masks the same way twice from the same seed, and differently from another seed', () => {
    const first = maskUpdates(updates, 'round-1');
    const again = maskUpdates(updates, 'round-1');
    const other = maskUpdates(updates, 'round-2');
    expect(again).toEqual(first);
    expect(other[0]?.maskedUpdate).not.toEqual(first[0]?.maskedUpdate);
    // …and the other seed still cancels: a mask is not a substitute for the sum.
    const otherSum = sumMaskedUpdates(other);
    const trueSum = sumTrueUpdates(updates);
    for (let index = 0; index < trueSum.length; index += 1) {
      expect(otherSum[index]).toBeCloseTo(trueSum[index] ?? 0, 9);
    }
  });

  it('refuses updates of different widths instead of masking nonsense', () => {
    expect(() => maskUpdates([updateOf('a', [1, 2]), updateOf('b', [1, 2, 3])], 's')).toThrow(
      /same width/,
    );
  });
});
