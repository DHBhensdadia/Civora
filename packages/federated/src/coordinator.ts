import { accountForRounds, epsilonPerRound } from './accountant';
import type { PrivacySpend } from './accountant';
import {
  addGaussianNoise,
  bytesOf,
  clipAndWeight,
  sumUpdates,
  updateDivergence,
} from './aggregate';
import { trainLocally } from './local';
import type { LocalTrainingOptions } from './local';
import { addParameters, meanSquaredError, vectorNorm, zeroParameters } from './model';
import type { ModelShape } from './model';
import { standardisedSamples } from './local';
import { maskUpdates, sumMaskedUpdates } from './masking';
import { inspectSiloPayload, siloPayloadOf } from './payload';
import { gaussian, sampleDistinct, streamFor } from './rng';
import type { SiloDataset, SiloStandardisation, SiloUpdate } from './types';

/**
 * The coordinator: what one federated round does, in the order it does it.
 *
 * The sequence is the design, so it is written down once here rather than
 * implied across five files:
 *
 *  0. **Agree the basis** before any round: the shared feature scale pooled from
 *     the silos' sums and counts (`scaling.ts`). It is configuration by the time
 *     round one starts, because an average of parameters in different units is
 *     not a model of anything.
 *  1. **Sample** the participating silos from a seeded stream. The sampling rate
 *     is not decoration — it is the `q` the accountant prices.
 *  2. **Train locally** in each sampled silo (FedProx, the shared basis,
 *     per-sample clipping as configured).
 *  3. **Clip and weight** each update on the silo side of the boundary. The
 *     update that crosses is already bounded and already scaled.
 *  4. **Mask** the weighted updates when secure aggregation is on, so the
 *     coordinator sums without seeing any participant's update.
 *  5. **Add noise** `N(0, (σ · C · w_max)²)` per coordinate to the sum — the
 *     quantity the accountant prices. The multiplier is relative to the
 *     sensitivity of that sum, which clipping and weighting fixed in step 3.
 *     The draw is a standard normal, not a uniform: the accountant prices a
 *     Gaussian, and a mechanism that is not the one priced is not accounted
 *     for at all.
 *  6. **Apply** the aggregate as a delta to the shared model and record the
 *     round in a ledger that carries no record, no date and no feature value.
 *
 * Nothing in this function reads a clock, so the ledger is a pure function of
 * the silos, the configuration and the seed, and a test asserts two runs are
 * identical.
 */

export interface FederatedConfig {
  readonly rounds: number;
  /** Share of silos sampled per round, in (0, 1]. */
  readonly samplingRate: number;
  /**
   * The Gaussian's standard deviation in units of `clipNorm · w_max`.
   *
   * Zero is a legitimate mode — a run with no mechanism at all, which is what a
   * sweep's control needs — and it is not priced as ε = 0. There is no bound on
   * an unnoised sum, the accountant refuses to invent one, and the ledger
   * records `null`: *not accounted*, which is a different statement from *free*.
   */
  readonly noiseMultiplier: number;
  /** Norm each silo's update is clipped to. The sensitivity's base. */
  readonly clipNorm: number;
  /** Target δ the reported ε is converted at. */
  readonly delta: number;
  readonly shape: ModelShape;
  /** The shared basis every silo trains in. Null trains on the raw features. */
  readonly standardisation: SiloStandardisation | null;
  /** Local settings. The basis is deliberately not one of them. */
  readonly local: Omit<LocalTrainingOptions, 'seed' | 'standardisation'>;
  readonly maskUpdates: boolean;
  readonly seed: string;
}

export interface RoundParticipant {
  readonly siloId: string;
  readonly label: string;
  readonly sampleCount: number;
  readonly localLoss: number;
  readonly updateNorm: number;
}

export interface RoundLedgerEntry {
  readonly round: number;
  readonly participants: readonly RoundParticipant[];
  /** Mean squared error over participants' own samples, before their update. */
  readonly meanLocalLoss: number;
  /** Mean squared error over **every** silo's rows, after this round's update. */
  readonly globalLoss: number;
  /** Weighted spread of the updates: 0 identical, 1 disjoint. `null` under masking. */
  readonly divergence: number | null;
  readonly clippedSilos: number;
  readonly largestRawNorm: number;
  /** Per-coordinate standard deviation of the noise actually added. */
  readonly noiseStandardDeviation: number;
  /**
   * Cumulative ε after this round, at the δ in the configuration. `null` when
   * no noise was added: with no mechanism there is no bound, and a zero here
   * would read as a claim that the round was free.
   */
  readonly epsilonSpent: number | null;
  /** Bytes received this round, measured from the updates themselves. */
  readonly bytesIn: number;
  readonly masked: boolean;
}

export interface FederatedRun {
  readonly ledger: readonly RoundLedgerEntry[];
  readonly parameters: readonly number[];
  /** The accountant's report, or `null` when the run added no noise. */
  readonly spend: PrivacySpend | null;
  readonly featureNames: readonly string[];
  readonly initialLoss: number;
  readonly finalLoss: number;
  readonly config: FederatedConfig;
  /** Silos that ever participated. */
  readonly participated: readonly string[];
}

/**
 * Mean squared error over every silo's rows, in the basis the model lives in.
 *
 * The rows are put through the shared standardisation here rather than the raw
 * features being read, because a model trained in a basis and evaluated in raw
 * units is not evaluated at all. A null basis means the features were raw on both
 * sides, which is the documented alternative.
 *
 * In the shared basis the target has unit variance over the federation's rows,
 * so the figure this returns is dimensionless: **1 is the error of a model that
 * predicts the pooled mean**, and `1 − loss` is the share of the demand's
 * variance the model explains. That is what makes a loss comparable between two
 * runs and readable by somebody who has not seen the data — an error of 234,098
 * in units of demand² is neither.
 */
const evaluate = (
  shape: ModelShape,
  parameters: readonly number[],
  silos: readonly SiloDataset[],
  standardisation: SiloStandardisation | null,
): number => {
  const totalSamples = silos.reduce((total, silo) => total + silo.samples.length, 0);
  if (totalSamples === 0) {
    return 0;
  }
  const weighted = silos.reduce((total, silo) => {
    const rows =
      standardisation === null ? silo.samples : standardisedSamples(silo.samples, standardisation);
    return total + meanSquaredError(shape, parameters, rows) * rows.length;
  }, 0);
  return weighted / totalSamples;
};

export function runFederatedTraining(input: {
  readonly silos: readonly SiloDataset[];
  readonly config: FederatedConfig;
}): FederatedRun {
  const { silos, config } = input;
  if (silos.length === 0) {
    throw new Error('a federation with no silos cannot train');
  }
  const featureNames = silos[0]?.featureNames ?? [];
  let parameters: readonly number[] = zeroParameters(config.shape);
  const initialLoss = evaluate(config.shape, parameters, silos, config.standardisation);

  const ledger: RoundLedgerEntry[] = [];
  const participated = new Set<string>();
  // A mechanism with no noise has no bound to report, so the accountant is not
  // asked to price one: `null` crosses the ledger instead of a zero that would
  // read as "free".
  const accounting = {
    rounds: config.rounds,
    samplingRate: config.samplingRate,
    noiseMultiplier: config.noiseMultiplier,
    delta: config.delta,
  };
  const spends = config.noiseMultiplier > 0 ? epsilonPerRound(accounting) : null;

  for (let round = 0; round < config.rounds; round += 1) {
    const samplingDraw = streamFor(config.seed, `round-${String(round)}-sampling`);
    const wanted = Math.max(1, Math.round(config.samplingRate * silos.length));
    const chosen = sampleDistinct(samplingDraw, silos.length, wanted)
      .map((index) => silos[index])
      .filter((silo): silo is SiloDataset => silo !== undefined);

    const trained = chosen.map((silo) => {
      const result = trainLocally({
        shape: config.shape,
        global: parameters,
        samples: silo.samples,
        options: {
          ...config.local,
          standardisation: config.standardisation,
          seed: `${config.seed}|round-${String(round)}|${silo.siloId}`,
        },
      });
      participated.add(silo.siloId);
      return {
        silo,
        update: {
          siloId: silo.siloId,
          sampleCount: silo.samples.length,
          update: result.update,
          localLoss: result.firstLoss,
        } satisfies SiloUpdate,
      };
    });
    const updates: readonly SiloUpdate[] = trained.map((entry) => entry.update);

    // Every update is put through the payload shape check before it is used.
    // The sentinel scan happens where the sentinels are known (the batch
    // command and the console), over the same serialisation.
    for (const update of updates) {
      const inspection = inspectSiloPayload(siloPayloadOf(update));
      if (!inspection.ok) {
        throw new Error(
          `a silo update violates the payload allow-list: ${inspection.findings.join('; ')}`,
        );
      }
    }

    const { weighted, clippedSilos, maxWeight, largestRawNorm } = clipAndWeight(
      updates,
      config.clipNorm,
    );
    const divergence = config.maskUpdates ? null : updateDivergence(weighted);

    let aggregate: readonly number[];
    if (config.maskUpdates) {
      const masked = maskUpdates(weighted, `${config.seed}|round-${String(round)}-masks`);
      aggregate = sumMaskedUpdates(masked);
    } else {
      aggregate = sumUpdates(weighted);
    }

    const noiseStandardDeviation = config.noiseMultiplier * config.clipNorm * maxWeight;
    const noiseDraw = streamFor(config.seed, `round-${String(round)}-noise`);
    const noisy = addGaussianNoise(aggregate, noiseStandardDeviation, () => gaussian(noiseDraw));
    parameters = addParameters(parameters, noisy);

    const totalSamples = updates.reduce((total, entry) => total + entry.sampleCount, 0);
    const meanLocalLoss =
      totalSamples === 0
        ? 0
        : updates.reduce((total, entry) => total + entry.localLoss * entry.sampleCount, 0) /
          totalSamples;

    // Measured on every silo, not only the ones that participated this round,
    // so the column is comparable from round to round whatever was sampled.
    ledger.push({
      globalLoss: evaluate(config.shape, parameters, silos, config.standardisation),
      round,
      participants: trained.map(({ silo, update }) => ({
        siloId: silo.siloId,
        label: silo.label,
        sampleCount: update.sampleCount,
        localLoss: update.localLoss,
        updateNorm: vectorNorm(update.update),
      })),
      meanLocalLoss,
      divergence,
      clippedSilos,
      largestRawNorm,
      noiseStandardDeviation,
      epsilonSpent: spends?.[round] ?? null,
      bytesIn: updates.reduce((total, entry) => total + bytesOf(entry.update), 0),
      masked: config.maskUpdates,
    });
  }

  const spend = config.noiseMultiplier > 0 ? accountForRounds(accounting) : null;

  return {
    ledger,
    parameters,
    spend,
    featureNames,
    initialLoss,
    finalLoss: evaluate(config.shape, parameters, silos, config.standardisation),
    config,
    participated: [...participated].sort(),
  };
}
