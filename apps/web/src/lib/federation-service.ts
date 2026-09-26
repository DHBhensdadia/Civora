import { generateRoundNarratives, selectReasoningProvider } from '@civora/ai';
import type { NarrativeAttempt } from '@civora/ai';
import {
  FEDERATION_ARCHITECTURE_REFERENCE,
  FEDERATION_HONESTY_BOUNDARY,
  FEDERATION_SUBSTRATE_NOTE,
} from '@civora/federated';
import type { PrivacySpend, RoundLedgerEntry, RoundParticipant } from '@civora/federated';
import {
  DEFAULT_SCENARIO_ID,
  DEMO_HISTORY_FACILITIES_PER_REGION,
  DEMO_SEED,
  FEDERATION_DEFAULTS,
  buildDemoDataset,
  compareFederation,
  federationRoundSeed,
  partitionFederationSilos,
  runFederation,
  sweepFederation,
} from '@civora/simulator';
import type {
  FederationOutcome,
  FederationPartition,
  FederationSweep,
  SiloComparison,
} from '@civora/simulator';

export type { FederationPartition };

import { getEnv } from '@/env';
import { recordAuditEvent } from './audit-service';
import type { AuditActor } from './audit-service';

/**
 * Samvad's console: the rounds, the ledger, the price of the guarantee, and the
 * boundary of what any of it claims.
 *
 * The runs here are the same calls `pnpm fl:run` and `pnpm fl:sweep` make over the
 * same generated world, through `@civora/simulator`'s shared runner. Two of them
 * are shown, deliberately, rather than one:
 *
 *  - **The algorithmic run** has no privacy mechanism at all. It answers what the
 *    federation does — whether sharing clipped updates beats a silo training
 *    alone, and whether the proximal term helps — and it is the run the report's
 *    comparison tables are taken from. A silo training alone needs no mechanism,
 *    so comparing a priced federated model against a noise-free local one would
 *    measure the noise and call it the federation.
 *  - **The priced run** carries the guarantee: the accountant solved σ for a
 *    target ε, the noise was added to the clipped aggregate, and the ledger shows
 *    the budget accumulating round by round. What it costs is not hidden: at this
 *    cohort size the noise is expensive, and the curve beside it is the
 *    measurement of that.
 *
 * Three honest limits travel with the payload, because a console is where a
 * federation demo is most likely to be read as a deployment:
 *
 *  - the silos are regions of a *simulated* world, partitioned in code on one
 *    machine (`decisions/0006`, quoted on the page from `statement.ts`);
 *  - the basis the silos train in is pooled from sums and counts, and those
 *    aggregates are **not** paid for in the ε the ledger reports — the ε prices
 *    the model updates only, and a deployment must price the statistic release
 *    separately or use a published scale;
 *  - the curve on this page is the same code at a smaller resolution than the
 *    generated document (`docs/federated-tradeoff.md`), and the page names the
 *    command that writes the full one.
 */

/** Rounds the console runs. Fewer than the document's, and stated on the page. */
export const CONSOLE_ROUNDS = 4;

/**
 * The ε targets the console's own curve is drawn at.
 *
 * Three points, chosen to span both halves of the finding rather than to show the
 * good news: a target at which the noise leaves the model worse than predicting
 * the pooled mean, the priced run's own target, and a target near the ceiling a
 * run with no mechanism reaches. A curve drawn only where it looks well would be
 * the one thing this page must not do. The values are read off the four-round
 * sweep (`pnpm fl:sweep --rounds 4 --epsilon 2,4,8,16,32 --dry-run`), and the
 * console's runs are four rounds, so the page and the document differ in
 * resolution rather than in kind.
 */
export const CONSOLE_CURVE_TARGETS: readonly number[] = [2, 8, 32];

/** The target the priced run on the page is asked for — the phase's own evidence ε. */
export const CONSOLE_EPSILON_TARGET = 8;

export interface FederationRoundView {
  readonly round: number;
  readonly participants: readonly RoundParticipant[];
  readonly rows: number;
  readonly meanLocalLoss: number;
  readonly globalLoss: number;
  /** Change in the shared model's error over this round; negative is better. */
  readonly lossChange: number;
  /** Weighted spread of the updates; null when masking hid them, which it does. */
  readonly divergence: number | null;
  readonly clippedSilos: number;
  readonly largestRawNorm: number;
  readonly noiseStandardDeviation: number;
  /** Cumulative ε after this round, or null when no mechanism ran. */
  readonly epsilonSpent: number | null;
  /** What this round added to the budget, from the cumulative figure. */
  readonly epsilonThisRound: number | null;
  readonly bytesIn: number;
  readonly masked: boolean;
}

export interface FederationRunView {
  readonly label: string;
  readonly meaning: string;
  readonly rounds: readonly FederationRoundView[];
  readonly initialLoss: number;
  readonly finalLoss: number;
  readonly improvement: number;
  readonly noiseMultiplier: number;
  readonly noiseReason: string;
  readonly epsilonTarget: number | null;
  readonly clipNorm: number;
  readonly delta: number;
  readonly samplingRate: number;
  readonly mu: number;
  readonly maskUpdates: boolean;
  readonly spend: PrivacySpend | null;
  readonly participated: readonly string[];
}

export interface FederationCurvePoint {
  readonly epsilonTarget: number;
  readonly noiseMultiplier: number | null;
  readonly reachable: boolean;
  readonly note: string | null;
  readonly finalLoss: number | null;
  readonly improvement: number | null;
  /** Whether the run beat a model that predicts the pooled mean (loss < 1). */
  readonly beatsMean: boolean | null;
}

export interface FederationConsole {
  readonly honesty: {
    readonly statement: string;
    readonly reference: string;
    readonly substrate: string;
    readonly simulated: string;
  };
  readonly world: {
    readonly seed: string;
    readonly roundSeed: string;
    readonly scenarioId: string;
    readonly scenarioLabel: string;
    readonly countryId: string;
    readonly countryName: string;
    readonly regionLevelName: string;
    readonly window: { readonly from: string; readonly to: string };
  };
  readonly partition: {
    readonly silos: number;
    readonly samples: number;
    readonly seriesRead: number;
    readonly seriesTooShort: number;
    readonly censoredDaysFound: number;
    readonly censoredDaysImputed: number;
    readonly imputations: readonly string[];
    readonly regionsWithoutHistory: number;
  };
  readonly basis: {
    readonly featureNames: readonly string[];
    readonly featureCount: number;
    readonly targetMean: number;
    readonly targetScale: number;
    readonly scaleExchange: { readonly payloads: number; readonly bytes: number };
    readonly paidFor: string;
  };
  readonly algorithmic: FederationRunView;
  readonly perSilo: readonly SiloComparison[];
  readonly totals: FederationOutcome['totals'];
  readonly proximal: {
    readonly mu: number;
    readonly fedAvgFinalLoss: number | null;
    readonly fedProxFinalLoss: number;
    readonly winner: 'fedavg' | 'fedprox' | null;
  };
  /** The non-IID diagnostic, from a run with masking off so it can be measured. */
  readonly diagnostic: {
    readonly available: boolean;
    readonly note: string;
    readonly divergenceByRound: readonly (number | null)[];
    readonly meanDivergence: number | null;
  };
  readonly priced: FederationRunView;
  readonly curve: {
    readonly quiet: { readonly initialLoss: number; readonly finalLoss: number };
    readonly points: readonly FederationCurvePoint[];
    readonly resolutionNote: string;
    /** The command that reproduces *this page's* three points. */
    readonly curveCommand: string;
    /** The command that writes the full-resolution document. */
    readonly artifactCommand: string;
  };
  readonly narratives: {
    readonly task: string;
    readonly attemptedOn: string;
    readonly oncePerProcess: string;
    readonly attempts: readonly NarrativeAttempt[];
    readonly refusals: number;
    readonly written: number;
  };
  readonly tests: readonly { readonly command: string; readonly what: string }[];
  readonly timing: {
    readonly generatedInMs: number;
    readonly buildMs: number;
    readonly runsMs: number;
  };
}

/** Rounds of a ledger as a surface reads them, with the per-round ε spelled out. */
function roundViews(ledger: readonly RoundLedgerEntry[]): readonly FederationRoundView[] {
  return ledger.map((entry, index) => {
    // Both differences are taken against the *previous* entry, and round 0's
    // "before" is the initial loss the run started from — which is the number the
    // coordinator measured over these rows, not a zero that would make the first
    // round look like a large step.
    const before = index === 0 ? null : (ledger[index - 1]?.globalLoss ?? null);
    const prior = index === 0 ? null : (ledger[index - 1]?.epsilonSpent ?? null);
    return {
      round: entry.round,
      participants: entry.participants,
      rows: entry.participants.reduce((total, participant) => total + participant.sampleCount, 0),
      meanLocalLoss: entry.meanLocalLoss,
      globalLoss: entry.globalLoss,
      lossChange: before === null ? 0 : entry.globalLoss - before,
      divergence: entry.divergence,
      clippedSilos: entry.clippedSilos,
      largestRawNorm: entry.largestRawNorm,
      noiseStandardDeviation: entry.noiseStandardDeviation,
      epsilonSpent: entry.epsilonSpent,
      // The first round's spend is the cumulative figure itself; later rounds are
      // the difference, so the page can show what each round cost rather than only
      // what the run has spent.
      epsilonThisRound: entry.epsilonSpent === null ? null : entry.epsilonSpent - (prior ?? 0),
      bytesIn: entry.bytesIn,
      masked: entry.masked,
    };
  });
}

interface ResolvedRun {
  readonly view: FederationRunView;
  readonly outcome: FederationOutcome;
}

function viewOf(input: {
  readonly label: string;
  readonly meaning: string;
  readonly outcome: FederationOutcome;
}): ResolvedRun {
  const { outcome } = input;
  const { config, epsilonTarget, noiseMultiplier, noiseReason } = outcome.resolved;
  return {
    outcome,
    view: {
      label: input.label,
      meaning: input.meaning,
      rounds: roundViews(outcome.run.ledger),
      initialLoss: outcome.run.initialLoss,
      finalLoss: outcome.run.finalLoss,
      improvement:
        outcome.run.initialLoss === 0 ? 0 : 1 - outcome.run.finalLoss / outcome.run.initialLoss,
      noiseMultiplier,
      noiseReason,
      epsilonTarget,
      clipNorm: config.clipNorm,
      delta: config.delta,
      samplingRate: config.samplingRate,
      mu: config.local.mu ?? 0,
      maskUpdates: config.maskUpdates,
      spend: outcome.run.spend,
      participated: outcome.run.participated,
    },
  };
}

const curvePointsOf = (sweep: FederationSweep): readonly FederationCurvePoint[] =>
  sweep.points.map((point) => ({
    epsilonTarget: point.epsilonTarget,
    noiseMultiplier: point.noiseMultiplier,
    reachable: point.reachable,
    note: point.note,
    finalLoss: point.finalLoss,
    improvement: point.improvement,
    beatsMean: point.finalLoss === null ? null : point.finalLoss < 1,
  }));

async function build(actor: AuditActor): Promise<FederationConsole> {
  const startedAt = Date.now();
  const dataset = buildDemoDataset(
    DEMO_HISTORY_FACILITIES_PER_REGION,
    DEMO_SEED,
    DEFAULT_SCENARIO_ID,
  );
  const roundSeed = federationRoundSeed(DEMO_SEED);
  const partition = partitionFederationSilos(
    { network: dataset.network, simulation: dataset.simulation },
    {},
  );
  if (partition.silos.length === 0) {
    throw new Error('the demonstration world holds no silo with usable history to federate');
  }

  const shared = { rounds: CONSOLE_ROUNDS, seed: roundSeed } as const;
  const runsStartedAt = Date.now();

  // 1. The algorithmic run: no mechanism. Comparisons are made here.
  const algorithmic = viewOf({
    label: `no mechanism · ${String(CONSOLE_ROUNDS)} rounds`,
    meaning:
      'the federation itself, with no noise and no privacy budget — the run the per-silo comparison is taken from',
    outcome: compareFederation(partition, { ...shared, epsilonTarget: null }),
  });

  // 2. The diagnostic: a second run with masking off, so the divergence is a
  //    measurement rather than a note explaining that it could not be taken.
  const diagnostic = runFederation(partition, {
    ...shared,
    epsilonTarget: null,
    maskUpdates: false,
  });
  const divergences = diagnostic.ledger.map((entry) => entry.divergence);
  const measured = divergences.filter((value): value is number => value !== null);

  // 3. The priced run: the guarantee, and its cost.
  const priced = viewOf({
    label: `ε = ${String(CONSOLE_EPSILON_TARGET)} · ${String(CONSOLE_ROUNDS)} rounds`,
    meaning:
      'the same rounds with Gaussian noise on the clipped aggregate and a budget the accountant spent',
    outcome: compareFederation(partition, { ...shared, epsilonTarget: CONSOLE_EPSILON_TARGET }),
  });

  // 4. The curve, at the smaller resolution this page can afford: the same code
  //    the document uses, so the two cannot disagree about what was run.
  const sweep = sweepFederation(partition, {
    ...shared,
    epsilons: CONSOLE_CURVE_TARGETS,
  });
  const runsMs = Date.now() - runsStartedAt;

  // The rounds are the platform's arithmetic, but a session *caused* them and they
  // spend a privacy budget, so the chain records who asked and what was taken. It
  // is written where the rounds are actually taken, which is why a second reader
  // of a memoised console appends nothing: no further budget was spent.
  const spent = priced.view.rounds.at(-1)?.epsilonSpent ?? null;
  await recordAuditEvent({
    actor,
    action: 'federation-rounds-computed',
    subjectType: 'federation_round',
    subjectId: `${roundSeed}#${String(CONSOLE_ROUNDS)}@e${String(CONSOLE_EPSILON_TARGET)}`,
    reason: `the console's runs: the comparison, the priced run at ε=${String(
      CONSOLE_EPSILON_TARGET,
    )} and the curve at ${CONSOLE_CURVE_TARGETS.join(', ')}`,
    // Nothing existed before this computation, and what it left behind is the
    // budget: the pair states the spend rather than a state change.
    before: null,
    after: `${String(CONSOLE_ROUNDS)} rounds over ${String(
      partition.silos.length,
    )} silos${spent === null ? '' : ` · ε ${spent.toFixed(4)}`}`,
  });

  // 5. The round narrative, through the provider port. With no key configured
  //    every round refuses, and the refusal is the shipped state: no fixture is
  //    invented to fill the panel.
  const provider = selectReasoningProvider({
    provider: getEnv().reasoningProvider,
    apiKey: getEnv().geminiApiKey,
    model: getEnv().geminiModel,
  });
  const narrativeRounds = priced.view.rounds;
  const inputs = narrativeRounds.map((round, index) => ({
    round: round.round,
    rounds: narrativeRounds.length,
    siloCount: partition.silos.length,
    countryId: partition.countryId,
    regionLevelName: partition.regionLevelName,
    model: 'linear',
    participants: round.participants,
    meanLocalLoss: round.meanLocalLoss,
    globalLossBefore:
      index === 0 ? priced.view.initialLoss : (narrativeRounds[index - 1]?.globalLoss ?? 0),
    globalLoss: round.globalLoss,
    divergence: round.divergence,
    clippedSilos: round.clippedSilos,
    noiseStandardDeviation: round.noiseStandardDeviation,
    epsilonTarget: priced.view.epsilonTarget,
    epsilonSpent: round.epsilonSpent,
    delta: priced.view.delta,
    bytesIn: round.bytesIn,
    masked: round.masked,
  }));
  const attempts = await generateRoundNarratives(provider, inputs);

  return {
    honesty: {
      statement: FEDERATION_HONESTY_BOUNDARY,
      reference: FEDERATION_ARCHITECTURE_REFERENCE,
      substrate: FEDERATION_SUBSTRATE_NOTE,
      simulated: `Every silo, row and loss on this page comes from the generated world seeded ${DEMO_SEED}.`,
    },
    world: {
      seed: DEMO_SEED,
      roundSeed,
      scenarioId: dataset.simulation.scenario.id,
      scenarioLabel: dataset.simulation.scenario.label,
      countryId: partition.countryId,
      countryName: partition.countryName,
      regionLevelName: partition.regionLevelName,
      window: { from: dataset.simulation.from, to: dataset.simulation.to },
    },
    partition: {
      silos: partition.silos.length,
      samples: partition.samples,
      seriesRead: partition.seriesRead,
      seriesTooShort: partition.seriesTooShort,
      censoredDaysFound: partition.censoredDaysFound,
      censoredDaysImputed: partition.censoredDaysImputed,
      imputations: partition.imputations,
      regionsWithoutHistory: partition.regionsWithoutHistory,
    },
    basis: {
      featureNames: partition.featureNames,
      featureCount: partition.featureNames.length,
      targetMean: partition.basis.targetMean,
      targetScale: partition.basis.targetScale,
      scaleExchange: {
        payloads: partition.scaleExchange.payloads,
        bytes: partition.scaleExchange.bytes,
      },
      paidFor:
        'The pooled sums and counts that agree this basis are not priced in the ε below. The ε prices the model updates; a deployment must price the statistic release as its own mechanism or use a published scale, and this build reports the exchange rather than calling it free.',
    },
    algorithmic: algorithmic.view,
    perSilo: algorithmic.outcome.perSilo,
    totals: algorithmic.outcome.totals,
    proximal: {
      mu: algorithmic.view.mu,
      fedAvgFinalLoss: algorithmic.outcome.fedAvg?.finalLoss ?? null,
      fedProxFinalLoss: algorithmic.outcome.run.finalLoss,
      winner: algorithmic.outcome.proximalWinner,
    },
    diagnostic: {
      available: measured.length > 0,
      note:
        measured.length > 0
          ? 'Measured in a run of the same configuration with masking off, because a masked coordinator cannot see the individual updates a spread is computed from. The priced run above reports `masked` for the same quantity, which is what secure aggregation is for.'
          : 'The divergence could not be measured in this configuration.',
      divergenceByRound: divergences,
      meanDivergence:
        measured.length === 0
          ? null
          : measured.reduce((total, value) => total + value, 0) / measured.length,
    },
    priced: priced.view,
    curve: {
      quiet: { initialLoss: sweep.quiet.initialLoss, finalLoss: sweep.quiet.finalLoss },
      points: curvePointsOf(sweep),
      resolutionNote: `Drawn here at ${CONSOLE_CURVE_TARGETS.join(', ')} and at ${String(
        CONSOLE_ROUNDS,
      )} rounds per point, from the same code the command uses. The full-resolution curve — every target from 1 to 128, six rounds per point, with its comparison tables — is the generated document below.`,
      curveCommand: `pnpm fl:sweep --epsilon ${CONSOLE_CURVE_TARGETS.join(
        ',',
      )} --rounds ${String(CONSOLE_ROUNDS)} --out docs/federated-tradeoff-curve`,
      artifactCommand: 'pnpm fl:sweep --epsilon 1,2,4,8,16,32,64,128 --out docs/federated-tradeoff',
    },
    narratives: {
      task: 'federation-narrative@1',
      attemptedOn: `round ${String(narrativeRounds.at(-1)?.round ?? 0)} of the priced run, and every round before it`,
      oncePerProcess:
        'Attempted once per process, when this console is first built, rather than on every read: a refresh that called the model again would be a burst nobody asked for.',
      attempts,
      refusals: attempts.filter((attempt) => attempt.status === 'refused').length,
      written: attempts.filter((attempt) => attempt.status === 'written').length,
    },
    tests: [
      {
        command: 'pnpm --filter @civora/federated test',
        what: 'the payload assertion (allow-list plus sentinel scan over the real outbound payload), the accountant against its published bounds, masking, and round determinism',
      },
      {
        command: 'pnpm fl:run --rounds 10 --silos all --dp --epsilon-target 8',
        what: 'the phase’s own evidence command: a whole run outside a browser, with the ledger printed',
      },
      {
        command: `pnpm fl:sweep --epsilon 1,2,4,8,16,32,64,128 --out docs/federated-tradeoff`,
        what: 'the generated curve this page is a smaller copy of',
      },
    ],
    timing: {
      generatedInMs: dataset.generatedInMs,
      runsMs,
      buildMs: Date.now() - startedAt,
    },
  };
}

let pending: Promise<FederationConsole> | undefined;

/**
 * The console, computed once per process and shared.
 *
 * Nine runs over a 94,680-row partition cost seconds, and every reader of the
 * same process is looking at the same world, the same seed and the same rounds —
 * so the alternative, recomputing per request, would buy nothing and make two
 * readers' figures differ. The actor is the session whose request caused the
 * first computation: it is the one the chain names, and later readers of the same
 * computed payload cause no round and no entry.
 */
export const readFederationConsole = (actor: AuditActor): Promise<FederationConsole> =>
  (pending ??= build(actor));

/** The defaults the console's runs inherit, so the page can state them. */
export const CONSOLE_DEFAULTS = {
  ...FEDERATION_DEFAULTS,
  rounds: CONSOLE_ROUNDS,
} as const;
