import type { PayloadInspection } from './payload';
import { fieldFindings, sentinelFindings, vectorFindings } from './payload';
import type { FederatedSample, SiloStandardisation } from './types';

/**
 * The basis the federation trains in, agreed before the first round.
 *
 * Federated averaging only means something if every silo's parameters are in the
 * same space. Standardising each silo against *its own* mean and spread puts each
 * model in that silo's units, and averaging two different units is not defined;
 * aggregating in raw units instead is defined but badly conditioned, which makes
 * the gradient noise the mechanism adds far larger than the step it is meant to
 * correct. So the basis is shared, and it is agreed the same way the
 * federated-statistics path agrees everything else: **sums and counts**.
 *
 * A silo's rows never leave it. What leaves is, per feature, the sum and the sum
 * of squares over the rows it holds, the same pair for the target, and how many
 * rows those are — the same class of disclosure `statistics.ts` already makes per
 * item, and subject to the same allow-list and sentinel scan
 * (`inspectScalePayload`).
 *
 * The target is pooled with the features because the loss and the parameter scale
 * have to be shared for the same reason the features do: an average of deltas
 * computed against different targets is not a delta on anything.
 *
 * Honest limit, stated here because the accountant cannot state it: these
 * aggregates are *not* paid for in the ε the round reports. The ε covers the
 * model updates. A production deployment must either price the statistic release
 * as its own mechanism or use a published scale; this build reports the
 * normalisation as a separate exchange rather than pretending it is free.
 */

/** One silo's per-feature sums and counts. Numbers only, by construction. */
export interface FeatureScaleSums {
  readonly count: number;
  readonly sums: readonly number[];
  readonly squares: readonly number[];
  /** The target's own sum and sum of squares, over the same rows. */
  readonly targetSum: number;
  readonly targetSquares: number;
}

/** Fields a scale payload may carry, and nothing else. */
export const ALLOWED_SCALE_FIELDS = [
  'kind',
  'siloId',
  'count',
  'sums',
  'squares',
  'targetSum',
  'targetSquares',
] as const;

export interface ScalePayload extends FeatureScaleSums {
  readonly kind: 'feature-scale';
  readonly siloId: string;
}

/** The sums a silo shares, computed from the rows it holds and nobody else's. */
export function featureScaleOf(samples: readonly FederatedSample[]): FeatureScaleSums {
  const width = samples[0]?.features.length ?? 0;
  const sums = new Array<number>(width).fill(0);
  const squares = new Array<number>(width).fill(0);
  let targetSum = 0;
  let targetSquares = 0;
  for (const sample of samples) {
    for (let index = 0; index < width; index += 1) {
      const value = sample.features[index] ?? 0;
      sums[index] = (sums[index] ?? 0) + value;
      squares[index] = (squares[index] ?? 0) + value * value;
    }
    targetSum += sample.target;
    targetSquares += sample.target * sample.target;
  }
  return { count: samples.length, sums, squares, targetSum, targetSquares };
}

export const scalePayloadOf = (
  siloId: string,
  samples: readonly FederatedSample[],
): ScalePayload => ({ kind: 'feature-scale', siloId, ...featureScaleOf(samples) });

/**
 * The blocking check for the scale payload, on the same terms as an update's.
 *
 * A statistics release can leak as surely as a parameter vector, so this shares
 * the update payload's three rules: only allow-listed fields, only finite
 * numbers, and no value that appears in the silo's raw records.
 */
export function inspectScalePayload(
  payload: ScalePayload,
  sentinels: readonly (string | number)[] = [],
): PayloadInspection {
  const findings: string[] = [];
  const record = payload as unknown as Record<string, unknown>;

  findings.push(...fieldFindings(record, ALLOWED_SCALE_FIELDS));
  findings.push(...vectorFindings('sums', payload.sums));
  findings.push(...vectorFindings('squares', payload.squares));
  if (!Number.isFinite(payload.count) || payload.count < 0) {
    findings.push('count is not a finite non-negative number');
  }
  if (!Number.isFinite(payload.targetSum)) {
    findings.push('targetSum is not a finite number');
  }
  if (!Number.isFinite(payload.targetSquares)) {
    findings.push('targetSquares is not a finite number');
  }
  findings.push(...sentinelFindings(payload, sentinels));

  return {
    ok: findings.length === 0,
    findings,
    serialised: JSON.stringify({
      kind: payload.kind,
      siloId: payload.siloId,
      count: payload.count,
      sums: payload.sums,
      squares: payload.squares,
      targetSum: payload.targetSum,
      targetSquares: payload.targetSquares,
    }),
  };
}

/**
 * Pool the silos' sums into one basis.
 *
 * The pooled mean is the total over the total count and the pooled spread is the
 * population standard deviation, both computed from sums alone — no row, and no
 * pair of rows, is needed for either. The target is pooled exactly the same way,
 * which is why it is a sum and not a scale somebody chose. A column that never
 * varies (or a target that never moves) is left alone rather than divided by
 * zero, exactly as in `siloStandardisation`.
 */
export function poolFeatureScale(parts: readonly FeatureScaleSums[]): SiloStandardisation {
  const count = parts.reduce((total, part) => total + part.count, 0);
  const width = Math.max(0, ...parts.map((part) => part.sums.length));
  const mean = new Array<number>(width).fill(0);
  const variance = new Array<number>(width).fill(0);

  if (count > 0) {
    for (let index = 0; index < width; index += 1) {
      const total = parts.reduce((sum, part) => sum + (part.sums[index] ?? 0), 0);
      const totalSquares = parts.reduce((sum, part) => sum + (part.squares[index] ?? 0), 0);
      const pooledMean = total / count;
      mean[index] = pooledMean;
      variance[index] = Math.max(0, totalSquares / count - pooledMean * pooledMean);
    }
  }

  const targetSum = parts.reduce((total, part) => total + part.targetSum, 0);
  const targetSquares = parts.reduce((total, part) => total + part.targetSquares, 0);
  const targetMean = count > 0 ? targetSum / count : 0;
  const targetVariance =
    count > 0 ? Math.max(0, targetSquares / count - targetMean * targetMean) : 0;
  const targetSpread = Math.sqrt(targetVariance);

  return {
    mean,
    scale: variance.map((value) => {
      const spread = Math.sqrt(value);
      return spread > 0 ? spread : 1;
    }),
    targetMean,
    targetScale: targetSpread > 0 ? targetSpread : 1,
  };
}
