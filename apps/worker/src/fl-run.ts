import { generateRoundNarrative, selectReasoningProvider } from '@civora/ai';
import {
  COUNTRY_IDENTIFIER_SETS,
  FEDERATION_ARCHITECTURE_REFERENCE,
  FEDERATION_HONESTY_BOUNDARY,
  FEDERATION_SUBSTRATE_NOTE,
  countryIdentifiersFor,
} from '@civora/federated';
import {
  DEFAULT_SCENARIO_ID,
  DEMO_HISTORY_FACILITIES_PER_REGION,
  DEMO_SEED,
  FEDERATION_DEFAULTS,
  buildDemoDataset,
  federationRoundSeed,
  compareFederation,
  partitionFederationSilos,
} from '@civora/simulator';
import type { FederationOutcome, FederationPartition } from '@civora/simulator';

import { federationDigestOf } from './federation-digest';

/**
 * `pnpm fl:run` — Samvad's federated rounds, outside a browser.
 *
 * The phase's evidence command is `pnpm fl:run --rounds 10 --silos all --dp
 * --epsilon-target 8`, and this is it. It builds the demonstration world from
 * its published seed, partitions it into one silo per state, runs the rounds
 * through `@civora/simulator`'s shared runner — the same call the Federation
 * Console makes — and prints what was measured: the per-round ledger, the ε the
 * accountant priced and spent, the per-silo comparison against training alone,
 * FedAvg against FedProx, and the honesty boundary.
 *
 * Three things it does not do, stated because a reader would otherwise assume
 * them:
 *
 *  - **It does not claim a deployed federation.** The silos are partitions of a
 *    simulated world on one machine. `decisions/0006` is quoted in the output
 *    rather than left to the documentation.
 *  - **It does not print an ε nobody accounted for.** With `--no-dp` there is no
 *    mechanism, so the ledger records an absent ε rather than a zero; with `--dp`
 *    the multiplier is solved from the target by bisecting the accounting
 *    computation, and the spend is that computation's own answer.
 *  - **It does not hide a losing comparison.** Every silo is printed, including
 *    the ones where training alone beat the federation, and FedAvg is printed
 *    beside FedProx whichever is better.
 */

const USAGE = `
Run Samvad's federated rounds over the demonstration world, one silo per state, and report
what was measured.

  pnpm fl:run [options]

Options
  --rounds <n>                rounds to run (default: ${String(FEDERATION_DEFAULTS.rounds)})
  --silos <all|n>             all silos, or the first n of the partition (default: all)
  --dp                        add noise and account for it; on by default, and stated here so
                              the phase's evidence command reads as written
  --no-dp                     run with no mechanism at all; the ledger then records no ε
  --epsilon-target <e>        target ε the noise multiplier is solved for (default: ${String(
    FEDERATION_DEFAULTS.epsilonTarget,
  )})
  --sampling-rate <q>         share of silos sampled per round, in (0, 1] (default: ${String(
    FEDERATION_DEFAULTS.samplingRate,
  )})
  --clip <c>                  norm each silo's update is clipped to (default: ${String(
    FEDERATION_DEFAULTS.clipNorm,
  )})
  --mu <value>                FedProx proximal weight; 0 is plain FedAvg (default: ${String(
    FEDERATION_DEFAULTS.mu,
  )})
  --model <linear|mlp>        the differentiable model to federate (default: linear)
  --country <id>              identifier set the silos are addressed with (default: SIM-IN;
                              registered: ${COUNTRY_IDENTIFIER_SETS.map((set) => set.countryId).join(', ')})
  --no-mask                   turn additive-mask secure aggregation off
  --epochs <n>                local epochs per round (default: 3)
  --batch-size <n>            local mini-batch size (default: 64)
  --learning-rate <value>     local learning rate (default: 0.05)
  --samples-per-series <n>    training rows kept per series, most recent first (default: 120)
  --seed <value>              world generation seed (default: ${DEMO_SEED}); the round seed is
                              derived from it, so one flag moves the whole run
  --digest-only               print only the run digest, for comparing two runs
  --narrative                 ask the configured reasoning provider for a summary of the last
                              round; with no provider configured it refuses, which is reported
  --help                      print this message

Every figure is simulated: the world, its facilities and its demand are generated. The rounds,
the clipping, the masking, the noise and the accounting are the real implementation. Nothing
here crosses a machine boundary, and decisions/0006 is displayed by the command itself.
`.trim();

class UsageError extends Error {}

interface Options {
  readonly rounds: number;
  readonly silos: number | 'all';
  readonly dp: boolean;
  readonly epsilonTarget: number;
  readonly samplingRate: number;
  readonly clipNorm: number;
  readonly mu: number;
  readonly model: 'linear' | 'mlp';
  readonly countryId: string;
  readonly maskUpdates: boolean;
  readonly epochs: number;
  readonly batchSize: number;
  readonly learningRate: number;
  readonly samplesPerSeries: number;
  readonly seed: string;
  readonly digestOnly: boolean;
  readonly narrative: boolean;
}

const SWITCHES = new Set([
  '--dp',
  '--no-dp',
  '--no-mask',
  '--digest-only',
  '--narrative',
  '--dry-run',
]);

const positiveNumber = (flag: string, raw: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${flag} needs a positive number, not "${raw}"`);
  }
  return value;
};

function parseArguments(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  const switches = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (SWITCHES.has(argument)) {
      switches.add(argument);
      continue;
    }
    if (!argument.startsWith('--')) {
      throw new UsageError(`unexpected argument "${argument}"`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${argument} needs a value`);
    }
    flags.set(argument, value);
    index += 1;
  }

  const known = new Set([
    '--rounds',
    '--silos',
    '--epsilon-target',
    '--sampling-rate',
    '--clip',
    '--mu',
    '--model',
    '--country',
    '--epochs',
    '--batch-size',
    '--learning-rate',
    '--samples-per-series',
    '--seed',
  ]);
  const unknown = [...flags.keys()].filter((flag) => !known.has(flag));
  if (unknown.length > 0) {
    throw new UsageError(`unknown option ${unknown.join(', ')}`);
  }

  const model = flags.get('--model') ?? 'linear';
  if (model !== 'linear' && model !== 'mlp') {
    throw new UsageError(`--model names a model this build does not federate: ${model}`);
  }

  const countryId = flags.get('--country') ?? 'SIM-IN';
  try {
    countryIdentifiersFor(countryId);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const samplingRate = flags.has('--sampling-rate')
    ? positiveNumber('--sampling-rate', flags.get('--sampling-rate') ?? '')
    : FEDERATION_DEFAULTS.samplingRate;
  if (samplingRate > 1) {
    throw new UsageError('--sampling-rate is a share of the silos, so it cannot exceed 1');
  }

  const silosRaw = flags.get('--silos') ?? 'all';
  const silos = silosRaw === 'all' ? 'all' : positiveNumber('--silos', silosRaw);
  if (silos !== 'all' && !Number.isInteger(silos)) {
    throw new UsageError(`--silos names all silos or a whole number of them, not "${silosRaw}"`);
  }

  const mu = flags.has('--mu') ? Number(flags.get('--mu')) : FEDERATION_DEFAULTS.mu;
  if (!Number.isFinite(mu) || mu < 0) {
    throw new UsageError(`--mu needs a non-negative number, not "${flags.get('--mu') ?? ''}"`);
  }

  const seed = flags.get('--seed') ?? DEMO_SEED;
  if (seed.trim() === '') {
    throw new UsageError('--seed needs a value');
  }

  return {
    rounds: flags.has('--rounds')
      ? positiveNumber('--rounds', flags.get('--rounds') ?? '')
      : FEDERATION_DEFAULTS.rounds,
    silos,
    dp: !switches.has('--no-dp'),
    epsilonTarget: flags.has('--epsilon-target')
      ? positiveNumber('--epsilon-target', flags.get('--epsilon-target') ?? '')
      : FEDERATION_DEFAULTS.epsilonTarget,
    samplingRate,
    clipNorm: flags.has('--clip')
      ? positiveNumber('--clip', flags.get('--clip') ?? '')
      : FEDERATION_DEFAULTS.clipNorm,
    mu,
    model,
    countryId,
    maskUpdates: !switches.has('--no-mask'),
    epochs: flags.has('--epochs') ? positiveNumber('--epochs', flags.get('--epochs') ?? '') : 3,
    batchSize: flags.has('--batch-size')
      ? positiveNumber('--batch-size', flags.get('--batch-size') ?? '')
      : 64,
    learningRate: flags.has('--learning-rate')
      ? positiveNumber('--learning-rate', flags.get('--learning-rate') ?? '')
      : 0.05,
    samplesPerSeries: flags.has('--samples-per-series')
      ? positiveNumber('--samples-per-series', flags.get('--samples-per-series') ?? '')
      : 120,
    seed,
    digestOnly: switches.has('--digest-only'),
    narrative: switches.has('--narrative'),
  };
}

/** A whole number with Indian digit grouping, so a reader can size it at a glance. */
const count = (value: number): string => value.toLocaleString('en-IN');

const fixed = (value: number, digits = 4): string => value.toFixed(digits);

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

/** The partition, narrowed to the silos this invocation was asked to run. */
const subsetOf = (partition: FederationPartition, wanted: number | 'all'): FederationPartition => {
  if (wanted === 'all') {
    return partition;
  }
  if (wanted > partition.silos.length) {
    throw new UsageError(
      `--silos asks for ${String(wanted)} silo(s) and the partition holds ${String(
        partition.silos.length,
      )}`,
    );
  }
  const silos = partition.silos.slice(0, wanted);
  return {
    ...partition,
    silos,
    samples: silos.reduce((total, silo) => total + silo.samples.length, 0),
  };
};

const verdictOf = (entry: FederationOutcome['perSilo'][number]): string =>
  entry.federatedBetter ? 'federation lower' : 'training alone lower';

async function run(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const startedAt = Date.now();
  const roundSeed = federationRoundSeed(options.seed);

  const dataset = buildDemoDataset(
    DEMO_HISTORY_FACILITIES_PER_REGION,
    options.seed,
    DEFAULT_SCENARIO_ID,
  );
  const partition = subsetOf(
    partitionFederationSilos(
      { network: dataset.network, simulation: dataset.simulation },
      { countryId: options.countryId, maxSamplesPerSeries: options.samplesPerSeries },
    ),
    options.silos,
  );
  if (partition.silos.length === 0) {
    throw new Error(
      'the partition holds no silo with usable history, so there is nothing to federate',
    );
  }

  const outcome = compareFederation(partition, {
    rounds: options.rounds,
    samplingRate: options.samplingRate,
    clipNorm: options.clipNorm,
    mu: options.mu,
    kind: options.model,
    epochs: options.epochs,
    batchSize: options.batchSize,
    learningRate: options.learningRate,
    maskUpdates: options.maskUpdates,
    seed: roundSeed,
    epsilonTarget: options.dp ? options.epsilonTarget : null,
  });
  const elapsedMs = Date.now() - startedAt;
  const { config } = outcome.resolved;
  const federated = outcome.run;

  const digest = federationDigestOf({
    partition,
    outcome,
    simulation: dataset.simulation,
    model: options.model,
    elapsedMs,
  });

  if (options.digestOnly) {
    process.stdout.write(`${digest.text}\nsha256:${digest.sha256}\n`);
    return 0;
  }

  const improvement =
    federated.initialLoss === 0 ? 0 : 1 - federated.finalLoss / federated.initialLoss;
  const last = federated.ledger.at(-1) ?? null;
  const previousLoss =
    federated.ledger.length >= 2
      ? (federated.ledger.at(-2)?.globalLoss ?? federated.initialLoss)
      : federated.initialLoss;

  const lines: string[] = [
    '',
    'Samvad — one federated run over the demonstration world, computed here and nowhere else',
    '',
    `  world              ${partition.countryId} at ${partition.regionLevelName} level · scenario ${DEFAULT_SCENARIO_ID} · world seed ${options.seed} · round seed ${roundSeed}`,
    `  partition          ${count(partition.silos.length)} silo(s) · ${count(
      partition.seriesRead,
    )} series read · ${count(partition.seriesTooShort)} too short · ${count(
      partition.samples,
    )} training row(s)${options.silos === 'all' ? '' : ` (a subset: ${String(options.silos)} of the partition)`}`,
    `  censored demand    ${count(partition.censoredDaysFound)} day(s) found · ${count(
      partition.censoredDaysImputed,
    )} imputed (${partition.imputations.join(', ') || 'none'}) — a stock-out is not low demand`,
    `  model              ${options.model} over ${String(
      partition.featureNames.length,
    )} feature(s) · ${String(config.rounds)} round(s) · sampling rate ${String(
      config.samplingRate,
    )} · clip ${String(config.clipNorm)} · δ ${String(config.delta)}`,
    `  cohort             ${String(partition.silos.length)} silo(s), the largest holding ${count(
      Math.max(0, ...partition.silos.map((silo) => silo.samples.length)),
    )} of ${count(partition.samples)} row(s) — the noise the accountant prices is σ · clip · that share`,
    `  privacy            ${outcome.resolved.noiseReason}`,
    `  aggregation        weighted FedAvg with FedProx μ = ${String(
      config.local.mu ?? 0,
    )} · additive masking ${config.maskUpdates ? 'on' : 'off'}`,
    `  learning           ${fixed(federated.initialLoss)} → ${fixed(
      federated.finalLoss,
    )} (explained ${percent(improvement)} of the demand’s variance)`,
    '  loss unit          mean squared error in the shared basis, where the target has unit variance:',
    '                     1 is what a model that predicts the pooled mean scores, so 1 − loss is the',
    '                     share of the demand’s variance the run explained',
    '',
    'Rounds — every figure below is a measurement the coordinator took:',
    '',
    '  round  participants  rows       mean local loss  global loss  divergence  ε after    bytes    masked',
  ];

  for (const round of federated.ledger) {
    const rows = round.participants.reduce((total, entry) => total + entry.sampleCount, 0);
    lines.push(
      `  ${String(round.round).padEnd(6)} ${String(round.participants.length).padEnd(13)} ${count(
        rows,
      ).padEnd(10)} ${fixed(round.meanLocalLoss).padEnd(16)} ${fixed(round.globalLoss).padEnd(
        12,
      )} ${(round.divergence === null ? 'masked' : fixed(round.divergence, 4)).padEnd(
        11,
      )} ${(round.epsilonSpent === null ? 'none' : fixed(round.epsilonSpent, 4)).padEnd(
        10,
      )} ${count(round.bytesIn).padEnd(8)} ${round.masked ? 'yes' : 'no'}`,
    );
  }

  lines.push(
    '',
    `  Per-round wall clock is deliberately not in the ledger: the ledger is a pure function of the world, the configuration and the seed, so two processes can compare it. The command measured ${count(
      elapsedMs,
    )} ms for the whole invocation (${count(
      Math.round(elapsedMs / Math.max(1, config.rounds)),
    )} ms a round, including the world's own generation).`,
    '',
    'Per silo — local-only is a model trained on that silo alone, from the same origin, same settings:',
    '',
    '  silo                        rows      local-only  federated   difference  verdict',
  );

  for (const entry of outcome.perSilo) {
    lines.push(
      `  ${entry.siloId.padEnd(27)} ${count(entry.sampleCount).padEnd(9)} ${fixed(
        entry.localOnlyLoss,
      ).padEnd(11)} ${fixed(entry.federatedLoss).padEnd(11)} ${
        entry.difference >= 0 ? '+' : ''
      }${fixed(entry.difference).padEnd(11)} ${verdictOf(entry)}`,
    );
  }

  lines.push(
    `  → ${String(outcome.totals.silosWhereFederationHelped)} of ${String(
      outcome.perSilo.length,
    )} silo(s) ended lower under the federation; ${String(
      outcome.totals.silosWhereLocalWon,
    )} ended lower trained alone. Weighted over the rows: local-only ${fixed(
      outcome.totals.localOnlyLoss,
    )} against federated ${fixed(outcome.totals.federatedLoss)}.`,
    '    A silo where the federation lost is reported as a loss: the cold-start path and the',
    '    data-sovereignty property hold either way, and a rigged comparison would be worth less',
    '    than this one.',
    '    Read the two columns with the mechanism in mind: a silo training alone needs no privacy',
    '    mechanism, so the local-only column is noise-free while the federated one is priced. With',
    '    --no-dp the difference is the federation; with --dp it is the federation and the noise.',
    '',
    'FedAvg against FedProx — both reported, whichever way it falls:',
    '',
  );

  if (outcome.fedAvg === null) {
    lines.push('  not compared: this run configured μ = 0, so both variants are the same run.', '');
  } else {
    lines.push(
      `  FedAvg   μ = 0        final ${fixed(outcome.fedAvg.finalLoss)}`,
      `  FedProx  μ = ${String(config.local.mu ?? 0).padEnd(8)} final ${fixed(
        federated.finalLoss,
      )}  ← ${outcome.proximalWinner === 'fedavg' ? 'FedAvg' : 'FedProx'} lower`,
      '',
    );
  }

  lines.push(
    'The privacy claim, and the test behind it: every silo update was put through the payload',
    'allow-list and the sentinel scan before it was aggregated, so a payload carrying a record',
    'identifier, a feature value or a date cannot be aggregated at all — and the test that makes',
    'that falsifiable is shown to fire on a payload built to leak:',
    '',
    '  pnpm --filter @civora/federated test   # payload assertion, accountant, masking, determinism',
    '',
    'The honesty boundary — read this before quoting anything above:',
    '',
    `  ${FEDERATION_HONESTY_BOUNDARY}`,
    '',
    `  ${FEDERATION_ARCHITECTURE_REFERENCE}`,
    `  ${FEDERATION_SUBSTRATE_NOTE}`,
    '  Every silo, row and loss above is simulated end to end.',
    '',
    'The digest — the same run written down the same way every time, so two processes can be compared:',
    '',
    digest.text,
    `sha256:${digest.sha256}`,
    '',
  );

  if (options.narrative) {
    const provider = selectReasoningProvider({
      provider: process.env.CIVORA_REASONING_PROVIDER,
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL,
    });
    if (last === null) {
      lines.push('Narrative: no round ran, so there is nothing to narrate.', '');
    } else {
      const attempt = await generateRoundNarrative(provider, {
        round: last.round,
        rounds: config.rounds,
        siloCount: partition.silos.length,
        countryId: partition.countryId,
        regionLevelName: partition.regionLevelName,
        model: options.model,
        participants: last.participants,
        meanLocalLoss: last.meanLocalLoss,
        globalLossBefore: previousLoss,
        globalLoss: last.globalLoss,
        divergence: last.divergence,
        clippedSilos: last.clippedSilos,
        noiseStandardDeviation: last.noiseStandardDeviation,
        epsilonTarget: outcome.resolved.epsilonTarget,
        epsilonSpent: last.epsilonSpent,
        delta: config.delta,
        bytesIn: last.bytesIn,
        masked: last.masked,
      });
      lines.push(
        `Narrative for round ${String(last.round)} — task federation-narrative@1, attempted through the provider port:`,
        '',
        ...(attempt.status === 'written'
          ? [
              `  ${attempt.narrative?.headline ?? ''}`,
              `  ${attempt.narrative?.summary ?? ''}`,
              ...(attempt.narrative?.limitations ?? []).map(
                (limitation) => `  limitation: ${limitation}`,
              ),
            ]
          : [
              `  status refused · provider ${attempt.provider}`,
              `  ${attempt.refusal ?? 'no reason reported'}`,
              '  With no provider configured every round refuses, and that refusal is the shipped state:',
              '  no fixture is invented to fill the panel, and the Federation Console displays the same sentence.',
            ]),
        '',
      );
    }
  }

  if (argv.includes('--dry-run')) {
    lines.push(
      'Note: --dry-run is accepted for consistency with the other batch commands and writes nothing',
      'either way; this command has no store to write to.',
      '',
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exitCode = 0;
} else {
  run(argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof UsageError) {
        process.stderr.write(`\n${error.message}\n\n${USAGE}\n`);
        process.exitCode = 2;
      } else {
        process.stderr.write(
          `\nfl:run failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
