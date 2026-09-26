import {
  clipVector,
  meanSquaredError,
  sampleGradient,
  subtractParameters,
  vectorNorm,
} from './model';
import type { ModelShape } from './model';
import { shuffled, streamFor } from './rng';
import type { FederatedSample, SiloStandardisation } from './types';

/**
 * One silo's local training.
 *
 * Three things are deliberately local, because doing them anywhere else would
 * require the raw rows to travel: the standardisation statistics are computed
 * from the silo's own samples, the mini-batch order is drawn from a seed the
 * silo owns, and every gradient is computed where the record is. What leaves is
 * a parameter vector and a loss.
 *
 * Two mechanisms that are easy to confuse are kept apart here:
 *
 *  - **Per-sample gradient clipping** (`clipNorm`): each record's gradient is
 *    bounded before it is averaged into a step, which is the ADR's local
 *    DP-SGD building block and is reported as `clippedFraction`, so a reader can
 *    see how often it bit.
 *  - **The FedProx proximal term** (`mu`): state data is genuinely non-IID, so
 *    local optima wander. Each local step is pulled towards the global model it
 *    started from, which is what stops one silo's week of work from being
 *    overwritten by another's.
 *
 * Neither is a privacy guarantee on its own. The guarantee is the coordinator's
 * clipped aggregate plus Gaussian noise, and it is accounted for in
 * `accountant.ts` against the mechanism that was actually run.
 */

export type LocalOptimizer = 'sgd' | 'adam';

export interface LocalTrainingOptions {
  readonly epochs?: number;
  readonly batchSize?: number;
  readonly learningRate?: number;
  readonly optimizer?: LocalOptimizer;
  /** FedProx proximal weight. Zero is plain FedAvg. */
  readonly mu?: number;
  /** Ridge penalty on weights. */
  readonly l2?: number;
  /** Per-sample gradient clip. `Infinity` disables it, explicitly. */
  readonly clipNorm?: number;
  /** Required: an unreproducible local step is an unreproducible round ledger. */
  readonly seed: string;
  /**
   * The **shared** basis the rows and the model are expressed in, agreed before
   * the first round (`scaling.ts`). Null trains on the features as recorded.
   *
   * There is deliberately no per-silo option here. Standardising each silo
   * against its own mean and spread would put every silo's parameters in that
   * silo's units, and an average of different units is not a model of anything;
   * training in raw units is defined but so badly conditioned that the noise the
   * mechanism adds swamps the step it is meant to correct. So the basis is
   * shared or absent, and this is where that decision is enforced rather than
   * documented.
   */
  readonly standardisation?: SiloStandardisation | null;
}

export const DEFAULT_LOCAL_OPTIONS = {
  epochs: 3,
  batchSize: 64,
  learningRate: 0.05,
  optimizer: 'adam' as LocalOptimizer,
  mu: 0.05,
  l2: 0.0001,
  clipNorm: 1,
} as const;

export interface LocalTrainingResult {
  readonly parameters: readonly number[];
  readonly update: readonly number[];
  /** The basis these parameters are in, or null when the features were raw. */
  readonly standardisation: SiloStandardisation | null;
  readonly firstLoss: number;
  readonly lastLoss: number;
  readonly steps: number;
  /** Share of per-sample gradients the clip actually shortened. */
  readonly clippedFraction: number;
}

/**
 * Mean and spread per feature, and of the target, from the silo's own rows.
 *
 * This is the one-silo form of what `scaling.ts` pools across a federation: the
 * two must agree, and `scaling.test.ts` asserts that the pooled statistics equal
 * what this returns over the whole population's rows, so a silo's own numbers and
 * the federation's agreed basis cannot drift apart.
 */
export function siloStandardisation(samples: readonly FederatedSample[]): SiloStandardisation {
  const width = samples[0]?.features.length ?? 0;
  const mean = new Array<number>(width).fill(0);
  for (const sample of samples) {
    for (let index = 0; index < width; index += 1) {
      mean[index] = (mean[index] ?? 0) + (sample.features[index] ?? 0);
    }
  }
  for (let index = 0; index < width; index += 1) {
    mean[index] = (mean[index] ?? 0) / Math.max(1, samples.length);
  }

  const variance = new Array<number>(width).fill(0);
  for (const sample of samples) {
    for (let index = 0; index < width; index += 1) {
      const deviation = (sample.features[index] ?? 0) - (mean[index] ?? 0);
      variance[index] = (variance[index] ?? 0) + deviation * deviation;
    }
  }
  // A feature that never varies is centred and left alone rather than divided by
  // zero: a constant column is useless, not fatal.
  const scale = variance.map((total) => {
    const spread = Math.sqrt(total / Math.max(1, samples.length));
    return spread > 0 ? spread : 1;
  });

  const count = Math.max(1, samples.length);
  const targetMean = samples.reduce((total, sample) => total + sample.target, 0) / count;
  const targetVariance =
    samples.reduce((total, sample) => {
      const deviation = sample.target - targetMean;
      return total + deviation * deviation;
    }, 0) / count;
  const targetSpread = Math.sqrt(targetVariance);

  return { mean, scale, targetMean, targetScale: targetSpread > 0 ? targetSpread : 1 };
}

/**
 * The rows as the basis sees them: features centred and scaled per column, and
 * the target standardised with them.
 *
 * The target is scaled for a reason that is arithmetic rather than tidiness. An
 * update is clipped to a norm before it is aggregated, so a round can move any
 * parameter by at most about `clipNorm · weight`; and with demand left in its own
 * units — a spread of a few hundred in the demonstration world — the weights that
 * fit it are of that same order. A run bounded like that needs hundreds of rounds
 * to arrive anywhere, and six rounds of it look like a model that does not learn
 * at all. In the shared basis the optimal weights are of order one, the round's
 * step and the mechanism's noise are both commensurate with the thing being
 * learned, and the loss becomes readable: `1` is the error of predicting the
 * pooled mean, so `1 − loss` is the share of the demand's variance explained.
 */
export const standardisedSamples = (
  samples: readonly FederatedSample[],
  statistics: SiloStandardisation,
): readonly FederatedSample[] =>
  samples.map((sample) => ({
    features: sample.features.map(
      (value, index) => (value - (statistics.mean[index] ?? 0)) / (statistics.scale[index] ?? 1),
    ),
    target: (sample.target - statistics.targetMean) / statistics.targetScale,
  }));

/** Gradient of the ridge penalty: weights only, biases left unpenalised. */
const l2Gradient = (
  shape: ModelShape,
  parameters: readonly number[],
  l2: number,
): readonly number[] =>
  parameters.map((value, index) => {
    if (l2 === 0) {
      return 0;
    }
    if (shape.kind === 'linear') {
      return index < shape.featureCount ? 2 * l2 * value : 0;
    }
    const inputCount = shape.featureCount + 1;
    const unit = Math.floor(index / inputCount);
    const within = index - unit * inputCount;
    const isInputWeight = unit < shape.hiddenUnits && within < shape.featureCount;
    const outputOffset = shape.hiddenUnits * inputCount;
    const isOutputWeight = index >= outputOffset && index < outputOffset + shape.hiddenUnits;
    return isInputWeight || isOutputWeight ? 2 * l2 * value : 0;
  });

/**
 * Train one silo from the global model, and return what it proposes.
 *
 * The return value is the **change** (`update`) as well as the parameters, so
 * the coordinator never has to reconstruct one from the other and a caller
 * cannot accidentally aggregate absolute models rather than deltas.
 */
export function trainLocally(input: {
  readonly shape: ModelShape;
  readonly global: readonly number[];
  readonly samples: readonly FederatedSample[];
  readonly options: LocalTrainingOptions;
}): LocalTrainingResult {
  const { shape, global, samples } = input;
  const epochs = input.options.epochs ?? DEFAULT_LOCAL_OPTIONS.epochs;
  const batchSize = input.options.batchSize ?? DEFAULT_LOCAL_OPTIONS.batchSize;
  const learningRate = input.options.learningRate ?? DEFAULT_LOCAL_OPTIONS.learningRate;
  const optimizer = input.options.optimizer ?? DEFAULT_LOCAL_OPTIONS.optimizer;
  const mu = input.options.mu ?? DEFAULT_LOCAL_OPTIONS.mu;
  const l2 = input.options.l2 ?? DEFAULT_LOCAL_OPTIONS.l2;
  const clipNorm = input.options.clipNorm ?? DEFAULT_LOCAL_OPTIONS.clipNorm;
  const statistics = input.options.standardisation ?? null;
  const rows = statistics === null ? samples : standardisedSamples(samples, statistics);

  // The model, the losses and the update all live in the basis the rows are in.
  // In the shared basis the target has unit variance, so the loss is a share of
  // the demand's variance rather than a quantity in units of demand squared —
  // the only form in which two runs, or two silos, can be compared at all.
  const firstLoss = meanSquaredError(shape, global, rows);
  const anchor = global;
  let parameters: readonly number[] = [...anchor];

  const firstMoment = new Array<number>(global.length).fill(0);
  const secondMoment = new Array<number>(global.length).fill(0);
  let adamStep = 0;
  let steps = 0;
  let clippedCount = 0;
  let gradientCount = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const order = shuffled(streamFor(input.options.seed, `epoch-${String(epoch)}`), rows);
    for (let start = 0; start < order.length; start += batchSize) {
      const batch = order.slice(start, start + batchSize);
      if (batch.length === 0) {
        continue;
      }

      const batchGradient = new Array<number>(global.length).fill(0);
      for (const sample of batch) {
        const raw = sampleGradient(shape, parameters, sample.features, sample.target);
        const before = vectorNorm(raw);
        const guarded = clipVector(raw, clipNorm);
        gradientCount += 1;
        if (vectorNorm(guarded) < before) {
          clippedCount += 1;
        }
        for (let index = 0; index < batchGradient.length; index += 1) {
          batchGradient[index] = (batchGradient[index] ?? 0) + (guarded[index] ?? 0);
        }
      }
      const ridge = l2Gradient(shape, parameters, l2);
      for (let index = 0; index < batchGradient.length; index += 1) {
        batchGradient[index] =
          (batchGradient[index] ?? 0) / batch.length +
          (ridge[index] ?? 0) +
          // The proximal anchor is the global model in the basis being trained —
          // which is what makes FedProx's `w_t` the model the silo started from.
          mu * ((parameters[index] ?? 0) - (anchor[index] ?? 0));
      }

      steps += 1;
      if (optimizer === 'adam') {
        adamStep += 1;
        const beta1 = 0.9;
        const beta2 = 0.999;
        const epsilon = 1e-8;
        parameters = parameters.map((value, index) => {
          const gradient = batchGradient[index] ?? 0;
          firstMoment[index] = beta1 * (firstMoment[index] ?? 0) + (1 - beta1) * gradient;
          secondMoment[index] =
            beta2 * (secondMoment[index] ?? 0) + (1 - beta2) * gradient * gradient;
          const correctedFirst = (firstMoment[index] ?? 0) / (1 - beta1 ** adamStep);
          const correctedSecond = (secondMoment[index] ?? 0) / (1 - beta2 ** adamStep);
          return value - (learningRate * correctedFirst) / (Math.sqrt(correctedSecond) + epsilon);
        });
      } else {
        parameters = parameters.map(
          (value, index) => value - learningRate * (batchGradient[index] ?? 0),
        );
      }
    }
  }

  const lastLoss = meanSquaredError(shape, parameters, rows);

  return {
    parameters,
    update: subtractParameters(parameters, global),
    standardisation: statistics,
    firstLoss,
    lastLoss,
    steps,
    clippedFraction: gradientCount === 0 ? 0 : clippedCount / gradientCount,
  };
}
