import type { Imputation } from '@civora/domain';
import type { LocalOptimizer, ModelKind } from '@civora/federated';
import {
  DEFAULT_LOCAL_OPTIONS,
  buildSiloSamples,
  countryIdentifiersFor,
  inspectScalePayload,
  linearShape,
  meanSquaredError,
  mlpShape,
  noiseMultiplierForTarget,
  poolFeatureScale,
  runFederatedTraining,
  scalePayloadOf,
  siloIdentifiersFor,
  standardisedSamples,
  trainLocally,
  zeroParameters,
} from '@civora/federated';
import type {
  FederatedConfig,
  FederatedRun,
  ModelShape,
  PrivacySpend,
  RoundLedgerEntry,
  SiloDataset,
  SiloStandardisation,
} from '@civora/federated';

import type { DemandSeries } from '@civora/forecasting';

import { buildScoredSeries } from './dataset-series';
import type { Network } from './network';
import type { Simulation } from './simulation';

/**
 * The federation over the generated world, in one place.
 *
 * Two consumers run this: the batch commands (`pnpm fl:run`, `pnpm fl:sweep`)
 * and the Federation Console. They must not be two computations, for the same
 * reason the intelligence pipeline and the redistribution gather are shared —
 * a console that quietly trained a slightly different model would make the
 * command's numbers and the screen's numbers both true and different.
 *
 * The partitioning is physical: every state's series are read inside
 * `buildSiloSamples`, which lives in the silo, and what leaves is a parameter
 * vector, a count and a loss. The coordinator never receives a series.
 *
 * Three honest baselines are computed here rather than asserted:
 *
 *  - **Local-only, per silo**, from the same starting point the federation
 *    starts from, so \"federation helped here\" is a comparison and not a claim.
 *  - **FedAvg against FedProx**, both reported whichever way it falls. A
 *    proximal term that loses is a finding, not an embarrassment.
 *  - **The ε-versus-accuracy curve**, from real runs at each noise level, with a
 *    target the accountant cannot reach reported as unreachable rather than
 *    approximated.
 */

export const FEDERATION_SEED = 'civora-federation-2026';

/** Days of history read before the trailing window, matching the feature schema. */
export const FEDERATION_MINIMUM_HISTORY_DAYS = 28;

export interface FederationPartitionOptions {
  /** The country whose identifier vocabulary addresses the silos. */
  readonly countryId?: string;
  readonly minHistoryDays?: number;
  /** Samples kept per series, most recent first. Bounds the cost of a round. */
  readonly maxSamplesPerSeries?: number;
}

export interface FederationPartition {
  readonly countryId: string;
  readonly countryName: string;
  readonly regionLevelName: string;
  readonly silos: readonly SiloDataset[];
  readonly featureNames: readonly string[];
  /**
   * The basis every silo trains in, pooled from the silos' own sums and counts.
   *
   * It is agreed before the first round, like every other shared fact in this
   * platform: what crosses is a sum and a count per feature, never a row. The
   * alternative — every silo standardising against its own records — would put
   * each model in its own units, and the average of different units is not a
   * model of anything.
   */
  readonly basis: SiloStandardisation;
  /** The scale exchange, counted so a reader can see what it cost. */
  readonly scaleExchange: {
    readonly payloads: number;
    readonly bytes: number;
    /** Anything the blocking check found; a run with findings is refused. */
    readonly findings: readonly string[];
  };
  /** Federated regions with no series at all — reported, not silently skipped. */
  readonly regionsWithoutHistory: number;
  readonly seriesRead: number;
  readonly seriesTooShort: number;
  readonly censoredDaysFound: number;
  readonly censoredDaysImputed: number;
  /** Every imputation the included silos stated, so nothing is flattened away. */
  readonly imputations: readonly Imputation[];
  readonly samples: number;
}

/**
 * Partition the world into one silo per administrative region.
 *
 * The silo is the region, and the region's series are read only where they live.
 * A region with no history is not an error — the demonstration generates a
 * history for a sample of facilities — so it is counted and reported rather
 * than replaced with an empty silo that would train on nothing.
 */
export function partitionFederationSilos(
  input: { readonly network: Network; readonly simulation: Simulation },
  options: FederationPartitionOptions = {},
): FederationPartition {
  const country = countryIdentifiersFor(options.countryId ?? 'SIM-IN');
  const identifiers = siloIdentifiersFor(country, input.network.regions);
  const regionOfFacility = new Map<string, string>(
    input.network.facilities.map((facility) => [
      facility.id as string,
      facility.regionId as string,
    ]),
  );

  const byRegion = new Map<string, DemandSeries[]>();
  for (const entry of buildScoredSeries(input.simulation).entries) {
    const regionId = regionOfFacility.get(entry.series.facilityId);
    if (regionId === undefined) {
      continue;
    }
    const list = byRegion.get(regionId) ?? [];
    list.push(entry.series);
    byRegion.set(regionId, list);
  }

  const silos: SiloDataset[] = [];
  let regionsWithoutHistory = 0;
  let seriesRead = 0;
  let seriesTooShort = 0;
  let censoredDaysFound = 0;
  let censoredDaysImputed = 0;
  const imputations = new Set<Imputation>();

  for (const [position, region] of input.network.regions.entries()) {
    const identifier = identifiers[position];
    const series = byRegion.get(region.id) ?? [];
    if (identifier === undefined || series.length === 0) {
      regionsWithoutHistory += 1;
      continue;
    }

    const built = buildSiloSamples(series, {
      minHistoryDays: options.minHistoryDays ?? FEDERATION_MINIMUM_HISTORY_DAYS,
      ...(options.maxSamplesPerSeries === undefined
        ? {}
        : { maxSamplesPerSeries: options.maxSamplesPerSeries }),
    });
    seriesRead += built.seriesCount;
    seriesTooShort += built.shortSeries;
    censoredDaysFound += built.censoredDaysFound;
    censoredDaysImputed += built.censoredDaysImputed;
    imputations.add(built.imputation);

    if (built.samples.length === 0) {
      continue;
    }
    silos.push({
      siloId: identifier.siloId,
      label: identifier.label,
      featureNames: built.featureNames,
      samples: built.samples,
      seriesCount: built.seriesCount,
      censoredDaysFound: built.censoredDaysFound,
      censoredDaysImputed: built.censoredDaysImputed,
      imputation: built.imputation,
    });
  }

  // The basis, agreed the way every shared fact here is agreed: each silo's sums
  // and counts, inspected against the same allow-list an update is, then pooled.
  const scalePayloads = silos.map((silo) => scalePayloadOf(silo.siloId, silo.samples));
  const scaleFindings = scalePayloads.flatMap((payload) => inspectScalePayload(payload).findings);
  if (scaleFindings.length > 0) {
    throw new Error(
      `a silo's statistic payload violates the allow-list: ${scaleFindings.join('; ')}`,
    );
  }

  return {
    countryId: country.countryId,
    countryName: country.countryName,
    regionLevelName: country.regionLevelName,
    silos,
    featureNames: silos[0]?.featureNames ?? [],
    basis: poolFeatureScale(scalePayloads),
    scaleExchange: {
      payloads: scalePayloads.length,
      // Every number in the exchange, counted as it is written: a sum and a sum of
      // squares per feature, then the same pair for the target.
      bytes: scalePayloads.reduce(
        (total, payload) => total + (payload.sums.length + payload.squares.length + 2) * 8,
        0,
      ),
      findings: scaleFindings,
    },
    regionsWithoutHistory,
    seriesRead,
    seriesTooShort,
    censoredDaysFound,
    censoredDaysImputed,
    imputations: [...imputations].sort(),
    samples: silos.reduce((total, silo) => total + silo.samples.length, 0),
  };
}

export interface FederationRunOptions {
  readonly rounds?: number;
  readonly samplingRate?: number;
  readonly clipNorm?: number;
  readonly delta?: number;
  readonly seed?: string;
  readonly maskUpdates?: boolean;
  readonly kind?: ModelKind;
  readonly hiddenUnits?: number;
  /** FedProx proximal weight. Zero is plain FedAvg. */
  readonly mu?: number;
  readonly epochs?: number;
  readonly batchSize?: number;
  readonly learningRate?: number;
  readonly optimizer?: LocalOptimizer;
  /**
   * Target ε the noise multiplier is solved for. `null` runs with no mechanism
   * at all, which the ledger records as an absent ε rather than as zero.
   */
  readonly epsilonTarget?: number | null;
  /** An explicit noise multiplier; when given, no target is solved for. */
  readonly noiseMultiplier?: number;
}

export const FEDERATION_DEFAULTS = {
  rounds: 6,
  samplingRate: 1,
  clipNorm: 1,
  delta: 1e-5,
  maskUpdates: true,
  kind: 'linear' as ModelKind,
  epsilonTarget: 8,
  /** FedProx's proximal weight; the default is the local loop's own. */
  mu: DEFAULT_LOCAL_OPTIONS.mu,
} as const;

/**
 * The seed the rounds use, derived from the world's own seed.
 *
 * One flag moves both, so a command and a surface that are given the same world
 * seed also agree about the rounds — and a reader comparing two invocations can
 * see from the echoed seeds which of the two they changed.
 */
export const federationRoundSeed = (worldSeed: string): string => `samvad|${worldSeed}`;

export interface ResolvedFederationConfig {
  readonly config: FederatedConfig;
  readonly epsilonTarget: number | null;
  readonly noiseMultiplier: number;
  /** How the multiplier was arrived at, in a sentence a reader can check. */
  readonly noiseReason: string;
}

/** Everything a round needs, with the noise multiplier resolved from the target. */
export function federationConfigFor(
  partition: FederationPartition,
  options: FederationRunOptions = {},
): ResolvedFederationConfig {
  const rounds = options.rounds ?? FEDERATION_DEFAULTS.rounds;
  const samplingRate = options.samplingRate ?? FEDERATION_DEFAULTS.samplingRate;
  const delta = options.delta ?? FEDERATION_DEFAULTS.delta;
  const target =
    options.epsilonTarget === undefined ? FEDERATION_DEFAULTS.epsilonTarget : options.epsilonTarget;
  const width = partition.featureNames.length;
  const shape: ModelShape =
    options.kind === 'mlp' ? mlpShape(width, options.hiddenUnits) : linearShape(width);

  let noiseMultiplier: number;
  let noiseReason: string;
  if (options.noiseMultiplier !== undefined) {
    noiseMultiplier = options.noiseMultiplier;
    noiseReason = `the noise multiplier was given directly (${String(noiseMultiplier)})`;
  } else if (target === null) {
    noiseMultiplier = 0;
    noiseReason = 'no noise was added: this run has no mechanism, so the ledger records no ε';
  } else {
    noiseMultiplier = noiseMultiplierForTarget({ epsilon: target, delta, rounds, samplingRate });
    noiseReason = `σ = ${noiseMultiplier.toFixed(4)} is the multiplier the accountant solved for, so ${String(
      rounds,
    )} round(s) at a sampling rate of ${String(samplingRate)} spend ε = ${String(
      target,
    )} at δ = ${String(delta)}`;
  }

  return {
    epsilonTarget: target,
    noiseMultiplier,
    noiseReason,
    config: {
      rounds,
      samplingRate,
      noiseMultiplier,
      clipNorm: options.clipNorm ?? FEDERATION_DEFAULTS.clipNorm,
      delta,
      shape,
      standardisation: partition.basis,
      local: {
        epochs: options.epochs ?? DEFAULT_LOCAL_OPTIONS.epochs,
        batchSize: options.batchSize ?? DEFAULT_LOCAL_OPTIONS.batchSize,
        learningRate: options.learningRate ?? DEFAULT_LOCAL_OPTIONS.learningRate,
        optimizer: options.optimizer ?? DEFAULT_LOCAL_OPTIONS.optimizer,
        mu: options.mu ?? DEFAULT_LOCAL_OPTIONS.mu,
        l2: DEFAULT_LOCAL_OPTIONS.l2,
        clipNorm: options.clipNorm ?? FEDERATION_DEFAULTS.clipNorm,
      },
      maskUpdates: options.maskUpdates ?? FEDERATION_DEFAULTS.maskUpdates,
      seed: options.seed ?? FEDERATION_SEED,
    },
  };
}

/** Run the federation over a partition, from the resolved configuration. */
export function runFederation(
  partition: FederationPartition,
  options: FederationRunOptions = {},
): FederatedRun {
  const resolved = federationConfigFor(partition, options);
  return runFederatedTraining({ silos: partition.silos, config: resolved.config });
}

export interface SiloComparison {
  readonly siloId: string;
  readonly label: string;
  readonly sampleCount: number;
  /** Error of a model trained on this silo's rows alone, from the same origin. */
  readonly localOnlyLoss: number;
  /** Error of the shared model on those rows. */
  readonly federatedLoss: number;
  /** `localOnlyLoss − federatedLoss`; positive means the federation helped. */
  readonly difference: number;
  readonly federatedBetter: boolean;
}

export interface FederationOutcome {
  readonly resolved: ResolvedFederationConfig;
  readonly run: FederatedRun;
  readonly perSilo: readonly SiloComparison[];
  /** The weighted totals the per-silo figures are summarised by. */
  readonly totals: {
    readonly localOnlyLoss: number;
    readonly federatedLoss: number;
    readonly silosWhereFederationHelped: number;
    readonly silosWhereLocalWon: number;
  };
  /**
   * A second run under plain FedAvg (μ = 0) beside the configured proximal
   * weight. Both are reported; whichever is better is named.
   */
  readonly fedAvg: { readonly mu: number; readonly finalLoss: number } | null;
  readonly proximalWinner: 'fedavg' | 'fedprox' | null;
}

/**
 * Local-only against federated, per silo, and FedAvg against FedProx.
 *
 * The local-only model is trained from the same origin (`zeroParameters`) with
 * the same epochs, batch size and optimiser, so the difference between the two
 * columns is the federation and nothing else. The comparison is reported for
 * every silo, including the ones where training alone won.
 */
export function compareFederation(
  partition: FederationPartition,
  options: FederationRunOptions = {},
): FederationOutcome {
  const resolved = federationConfigFor(partition, options);
  const run = runFederatedTraining({ silos: partition.silos, config: resolved.config });
  const origin = zeroParameters(resolved.config.shape);

  const rowsOf = (samples: SiloDataset['samples']): SiloDataset['samples'] =>
    resolved.config.standardisation === null
      ? samples
      : standardisedSamples(samples, resolved.config.standardisation);

  const perSilo = partition.silos.map((silo): SiloComparison => {
    const alone = trainLocally({
      shape: resolved.config.shape,
      global: origin,
      samples: silo.samples,
      options: {
        ...resolved.config.local,
        standardisation: resolved.config.standardisation,
        seed: `${resolved.config.seed}|local|${silo.siloId}`,
      },
    });
    // Both columns are measured in the shared basis the models live in.
    const federatedLoss = meanSquaredError(
      resolved.config.shape,
      run.parameters,
      rowsOf(silo.samples),
    );
    return {
      siloId: silo.siloId,
      label: silo.label,
      sampleCount: silo.samples.length,
      localOnlyLoss: alone.lastLoss,
      federatedLoss,
      difference: alone.lastLoss - federatedLoss,
      federatedBetter: federatedLoss < alone.lastLoss,
    };
  });

  const totalSamples = Math.max(
    1,
    perSilo.reduce((total, entry) => total + entry.sampleCount, 0),
  );
  const totals = {
    localOnlyLoss:
      perSilo.reduce((total, entry) => total + entry.localOnlyLoss * entry.sampleCount, 0) /
      totalSamples,
    federatedLoss:
      perSilo.reduce((total, entry) => total + entry.federatedLoss * entry.sampleCount, 0) /
      totalSamples,
    silosWhereFederationHelped: perSilo.filter((entry) => entry.federatedBetter).length,
    silosWhereLocalWon: perSilo.filter((entry) => !entry.federatedBetter).length,
  };

  const mu = resolved.config.local.mu ?? 0;
  let fedAvg: FederationOutcome['fedAvg'] = null;
  let proximalWinner: FederationOutcome['proximalWinner'] = null;
  if (mu !== 0) {
    const averaged = runFederatedTraining({
      silos: partition.silos,
      config: { ...resolved.config, local: { ...resolved.config.local, mu: 0 } },
    });
    fedAvg = { mu: 0, finalLoss: averaged.finalLoss };
    proximalWinner = averaged.finalLoss < run.finalLoss ? 'fedavg' : 'fedprox';
  }

  return { resolved, run, perSilo, totals, fedAvg, proximalWinner };
}

export interface SweepPoint {
  readonly epsilonTarget: number;
  /** Null when the accountant could not reach the target with a finite σ. */
  readonly noiseMultiplier: number | null;
  readonly reachable: boolean;
  /** The accountant's own refusal sentence, when the target is out of reach. */
  readonly note: string | null;
  readonly initialLoss: number | null;
  readonly finalLoss: number | null;
  /** `1 − finalLoss / initialLoss`: the share of the error the run removed. */
  readonly improvement: number | null;
}

export interface FederationSweep {
  readonly points: readonly SweepPoint[];
  /**
   * The same configuration with no noise at all: the ceiling every point in the
   * curve is read against, so the cost of the privacy is a difference between
   * two runs rather than a number someone chose.
   */
  readonly quiet: { readonly initialLoss: number; readonly finalLoss: number };
  readonly pointsEvaluated: number;
  readonly pointsOutOfReach: number;
}

/**
 * The ε-versus-accuracy curve, from real runs.
 *
 * For each target, the accountant solves for the noise multiplier and the round
 * is actually run. A target the accountant cannot reach is recorded as
 * unreachable with its own sentence, because the alternative — nudging the
 * target until it succeeds — is the dishonesty this curve exists to prevent.
 */
export function sweepFederation(
  partition: FederationPartition,
  options: FederationRunOptions & { readonly epsilons?: readonly number[] } = {},
): FederationSweep {
  const epsilons = options.epsilons ?? [1, 2, 4, 8, 16];
  const quietRun = runFederatedTraining({
    silos: partition.silos,
    config: federationConfigFor(partition, { ...options, noiseMultiplier: 0 }).config,
  });

  const points: SweepPoint[] = epsilons.map((epsilonTarget): SweepPoint => {
    let noiseMultiplier: number;
    try {
      noiseMultiplier = federationConfigFor(partition, {
        ...options,
        epsilonTarget,
      }).noiseMultiplier;
    } catch (error) {
      return {
        epsilonTarget,
        noiseMultiplier: null,
        reachable: false,
        note: error instanceof Error ? error.message : String(error),
        initialLoss: null,
        finalLoss: null,
        improvement: null,
      };
    }
    const run = runFederation(partition, { ...options, epsilonTarget });
    return {
      epsilonTarget,
      noiseMultiplier,
      reachable: true,
      note: null,
      initialLoss: run.initialLoss,
      finalLoss: run.finalLoss,
      improvement: run.initialLoss === 0 ? 0 : 1 - run.finalLoss / run.initialLoss,
    };
  });

  return {
    points,
    quiet: { initialLoss: quietRun.initialLoss, finalLoss: quietRun.finalLoss },
    pointsEvaluated: points.filter((point) => point.reachable).length,
    pointsOutOfReach: points.filter((point) => !point.reachable).length,
  };
}

/** The privacy spend a run ended at, or null when no mechanism was run. */
export const spendOf = (run: FederatedRun): PrivacySpend | null => run.spend;

/** The last round in a ledger, for a caller that wants the cumulative figure. */
export const finalRoundOf = (run: FederatedRun): RoundLedgerEntry | null =>
  run.ledger.at(-1) ?? null;
