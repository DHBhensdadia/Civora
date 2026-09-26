import { gaussian, streamFor } from './rng';
import type { SiloUpdate } from './types';

/**
 * Secure aggregation: the coordinator observes only the sum.
 *
 * The protocol is additive pairwise masking, the cheap version that needs no
 * public-key infrastructure and no trusted third party:
 *
 *  1. For every pair of participants `(i, j)`, both derive the same pseudo-random
 *     vector from a seed and the pair's identity — in a deployment from a shared
 *     secret; here from a seed the round owns, because the point being
 *     demonstrated is the arithmetic, not key exchange.
 *  2. Silo `i` adds its pair vector; silo `j` subtracts it. Every vector appears
 *     exactly twice with opposite signs, so the masks cancel in the sum.
 *  3. The coordinator sums what it received. The sum is exact; no individual
 *     update is recoverable from it while every participant stays in the round.
 *
 * Dropouts need a cancellation round (a participant reveals its pair seeds), and
 * that is deliberately **not** implemented: this build samples its participants
 * before masking, so a silo in the round is a silo in the sum, and the code says
 * so rather than pretending to a robustness property it does not have.
 */

export interface MaskedUpdate {
  readonly siloId: string;
  readonly sampleCount: number;
  readonly localLoss: number;
  /** The update as the coordinator sees it: masked, and useless alone. */
  readonly maskedUpdate: readonly number[];
}

export function maskUpdates(updates: readonly SiloUpdate[], seed: string): readonly MaskedUpdate[] {
  const width = updates[0]?.update.length ?? 0;
  const masked = updates.map((entry) => {
    if (entry.update.length !== width) {
      throw new Error('masking needs every update to have the same width');
    }
    return { update: [...entry.update] };
  });

  for (let left = 0; left < updates.length; left += 1) {
    for (let right = left + 1; right < updates.length; right += 1) {
      const leftId = updates[left]?.siloId ?? String(left);
      const rightId = updates[right]?.siloId ?? String(right);
      const draw = streamFor(seed, `pair|${leftId}|${rightId}`);
      for (let index = 0; index < width; index += 1) {
        const value = gaussian(draw);
        const leftRow = masked[left];
        const rightRow = masked[right];
        if (leftRow !== undefined && rightRow !== undefined) {
          leftRow.update[index] = (leftRow.update[index] ?? 0) + value;
          rightRow.update[index] = (rightRow.update[index] ?? 0) - value;
        }
      }
    }
  }

  return updates.map((entry, index) => ({
    siloId: entry.siloId,
    sampleCount: entry.sampleCount,
    localLoss: entry.localLoss,
    maskedUpdate: masked[index]?.update ?? [],
  }));
}

/** What the coordinator can actually compute: the masked sum. */
export const sumMaskedUpdates = (masked: readonly MaskedUpdate[]): readonly number[] => {
  const width = masked[0]?.maskedUpdate.length ?? 0;
  const total = new Array<number>(width).fill(0);
  for (const entry of masked) {
    for (let index = 0; index < width; index += 1) {
      total[index] = (total[index] ?? 0) + (entry.maskedUpdate[index] ?? 0);
    }
  }
  return total;
};

/** The sum the masks are designed to cancel down to, for the test to compare. */
export const sumTrueUpdates = (updates: readonly SiloUpdate[]): readonly number[] => {
  const width = updates[0]?.update.length ?? 0;
  const total = new Array<number>(width).fill(0);
  for (const entry of updates) {
    for (let index = 0; index < width; index += 1) {
      total[index] = (total[index] ?? 0) + (entry.update[index] ?? 0);
    }
  }
  return total;
};
