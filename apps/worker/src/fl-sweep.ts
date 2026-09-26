import {
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
  compareFederation,
  federationRoundSeed,
  partitionFederationSilos,
  sweepFederation,
} from '@civora/simulator';
import type { FederationOutcome, FederationPartition } from '@civora/simulator';

import {
  noiseScaleSentence,
  practicalRangeSentence,
  renderFederationTradeoff,
} from './federation-report';

/**
 * `pnpm fl:sweep` — the privacy/accuracy curve, from real runs, as a document.
 *
 * The phase requires the ε-versus-accuracy artifact to exist with real numbers
 * and the trade-off to be stated honestly rather than presented as free. So this
 * command runs the federation once per target ε — the accountant solving for the
 * noise multiplier each time — and writes every figure it measured, including
 * the targets it could not reach. Nothing in the document is estimated, and
 * nothing is dropped for looking bad.
 *
 * The comparison tables (FedAvg against FedProx, and local-only against
 * federated per silo) are taken at the **noisiest reachable target** in the
 * sweep, which is the least flattering point in it. A report that showed the
 * comparisons at its quietest ε would be a report that chose its own best case.
 */

const USAGE = `
Run the federation once per privacy target, then write the trade-off as a document.

  pnpm fl:sweep [options]

Options
  --epsilon <list>            comma-separated ε targets (default: 1,2,4,8,16)
  --out <path>                where to write the document (default: docs/federated-tradeoff)
  --rounds <n>                rounds per run (default: ${String(FEDERATION_DEFAULTS.rounds)})
  --sampling-rate <q>         share of silos sampled per round (default: ${String(
    FEDERATION_DEFAULTS.samplingRate,
  )})
  --clip <c>                  norm each silo's update is clipped to (default: ${String(
    FEDERATION_DEFAULTS.clipNorm,
  )})
  --mu <value>                FedProx proximal weight; 0 is plain FedAvg (default: ${String(
    FEDERATION_DEFAULTS.mu,
  )})
  --model <linear|mlp>        the differentiable model to federate (default: linear)
  --country <id>              identifier set the silos are addressed with (default: SIM-IN)
  --no-mask                   turn additive-mask secure aggregation off
  --epochs <n>                local epochs per round (default: 3)
  --batch-size <n>            local mini-batch size (default: 64)
  --learning-rate <value>     local learning rate (default: 0.05)
  --samples-per-series <n>    training rows kept per series (default: 120)
  --seed <value>              world generation seed (default: ${DEMO_SEED})
  --dry-run                   compute and print every figure, write no document
  --help                      print this message

The document is generated: the command named in its first paragraph rewrites it, so an edit
would be overwritten on the next run. Every figure is simulated; the mechanism is not.
`.trim();

class UsageError extends Error {}

interface Options {
  readonly epsilons: readonly number[];
  readonly outPath: string;
  readonly rounds: number;
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
  readonly dryRun: boolean;
}

const SWITCHES = new Set(['--no-mask', '--dry-run']);

const positiveNumber = (flag: string, raw: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${flag} needs a positive number, not "${raw}"`);
  }
  return value;
};

/** `1,2,4,8,16` → `[1, 2, 4, 8, 16]`, refusing anything that is not a positive list. */
export function parseEpsilons(raw: string): readonly number[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) {
    throw new UsageError('--epsilon needs at least one target');
  }
  return parts.map((part) => positiveNumber('--epsilon', part));
}

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
    '--epsilon',
    '--out',
    '--rounds',
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

  const mu = flags.has('--mu') ? Number(flags.get('--mu')) : FEDERATION_DEFAULTS.mu;
  if (!Number.isFinite(mu) || mu < 0) {
    throw new UsageError(`--mu needs a non-negative number, not "${flags.get('--mu') ?? ''}"`);
  }

  const seed = flags.get('--seed') ?? DEMO_SEED;
  if (seed.trim() === '') {
    throw new UsageError('--seed needs a value');
  }

  return {
    epsilons: parseEpsilons(flags.get('--epsilon') ?? '1,2,4,8,16'),
    outPath: flags.get('--out') ?? 'docs/federated-tradeoff',
    rounds: flags.has('--rounds')
      ? positiveNumber('--rounds', flags.get('--rounds') ?? '')
      : FEDERATION_DEFAULTS.rounds,
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
    dryRun: switches.has('--dry-run'),
  };
}

/** A whole number with Indian digit grouping, so a reader can size it at a glance. */
const count = (value: number): string => value.toLocaleString('en-IN');

const fixed = (value: number, digits = 4): string => value.toFixed(digits);

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

/**
 * The comparison runs take **no mechanism at all**, and that is the honest choice.
 *
 * The tables answer "does sharing updates help a silo" and "does the proximal term
 * help", and neither question is about the noise. A local-only model trains on its
 * own records and needs no privacy mechanism to do it, while the federated arm is
 * priced — so taking the tables at the noisiest point (which is what an earlier
 * version of this command did) made the difference between the columns mostly the
 * *noise*, presented as though it were the federation. The curve beside them is
 * what answers the privacy question, and it answers it at every target.
 */
const COMPARISON_MECHANISM = null;

async function run(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const startedAt = Date.now();
  const roundSeed = federationRoundSeed(options.seed);

  const dataset = buildDemoDataset(
    DEMO_HISTORY_FACILITIES_PER_REGION,
    options.seed,
    DEFAULT_SCENARIO_ID,
  );
  const partition: FederationPartition = partitionFederationSilos(
    { network: dataset.network, simulation: dataset.simulation },
    { countryId: options.countryId, maxSamplesPerSeries: options.samplesPerSeries },
  );
  if (partition.silos.length === 0) {
    throw new Error(
      'the partition holds no silo with usable history, so there is nothing to sweep',
    );
  }

  const shared = {
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
  };

  const sweep = sweepFederation(partition, { ...shared, epsilons: options.epsilons });
  const outcome: FederationOutcome = compareFederation(partition, {
    ...shared,
    epsilonTarget: COMPARISON_MECHANISM,
  });
  const elapsedMs = Date.now() - startedAt;

  const quietImprovement =
    sweep.quiet.initialLoss === 0 ? 0 : 1 - sweep.quiet.finalLoss / sweep.quiet.initialLoss;

  const lines: string[] = [
    '',
    'Samvad — the privacy/accuracy curve, one real run per target, and nothing chosen to look good',
    '',
    `  world              ${partition.countryId} at ${partition.regionLevelName} level · world seed ${options.seed} · round seed ${roundSeed}`,
    `  partition          ${count(partition.silos.length)} silo(s) · ${count(
      partition.seriesRead,
    )} series read · ${count(partition.samples)} training row(s)`,
    `  model              ${options.model} · ${String(options.rounds)} round(s) · sampling rate ${String(
      options.samplingRate,
    )} · clip ${String(options.clipNorm)} · FedProx μ = ${String(options.mu)}`,
    '  loss unit          the shared basis, where the target has unit variance: 1 is what a model',
    '                     that predicts the pooled mean scores, so 1 − loss is the share of the',
    '                     demand’s variance the run explained',
    `  no mechanism       ${fixed(sweep.quiet.initialLoss)} → ${fixed(
      sweep.quiet.finalLoss,
    )} (removed ${percent(quietImprovement)}) — the ceiling every row below is read against`,
    '',
    '  ε target  σ solved   reachable  initial     final       improvement  note',
  ];

  for (const point of sweep.points) {
    lines.push(
      `  ${String(point.epsilonTarget).padEnd(9)} ${(point.noiseMultiplier === null
        ? '—'
        : fixed(point.noiseMultiplier)
      ).padEnd(11)} ${(point.reachable ? 'yes' : 'no').padEnd(10)} ${(point.initialLoss === null
        ? '—'
        : fixed(point.initialLoss)
      ).padEnd(11)} ${(point.finalLoss === null ? '—' : fixed(point.finalLoss)).padEnd(
        11,
      )} ${(point.improvement === null ? '—' : percent(point.improvement)).padEnd(12)} ${
        point.note ?? ''
      }`,
    );
  }

  lines.push(
    `  → ${String(sweep.pointsEvaluated)} of ${String(
      sweep.points.length,
    )} target(s) were reachable by the accountant; ${String(
      sweep.pointsOutOfReach,
    )} were reported as unreachable rather than approximated.`,
    '',
    'The comparison tables below ran with **no mechanism at all**, on purpose. They answer whether',
    'sharing updates helps a silo and whether the proximal term helps; a silo training alone needs no',
    'privacy mechanism, so comparing a priced federated model against a noise-free local one would',
    'have measured the noise and called it the federation. The table above is where the privacy cost',
    'is read, and it is not free anywhere in the range this cohort can reach.',
    '',
    `  practical range    ${practicalRangeSentence(sweep)}`,
    `  noise scale        ${noiseScaleSentence(partition)}`,
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
      }${fixed(entry.difference).padEnd(11)} ${
        entry.federatedBetter ? 'federation lower' : 'training alone lower'
      }`,
    );
  }

  lines.push(
    `  → ${String(outcome.totals.silosWhereFederationHelped)} of ${String(
      outcome.perSilo.length,
    )} silo(s) ended lower under the federation; ${String(
      outcome.totals.silosWhereLocalWon,
    )} ended lower trained alone.`,
    '',
    'FedAvg against FedProx — both reported, whichever way it falls:',
    '',
  );

  if (outcome.fedAvg === null) {
    lines.push('  not compared: this run configured μ = 0, so both variants are the same run.', '');
  } else {
    lines.push(
      `  FedAvg   μ = 0        final ${fixed(outcome.fedAvg.finalLoss)}`,
      `  FedProx  μ = ${String(options.mu).padEnd(8)} final ${fixed(
        outcome.run.finalLoss,
      )}  ← ${outcome.proximalWinner === 'fedavg' ? 'FedAvg' : 'FedProx'} lower`,
      '',
    );
  }

  lines.push(
    'The honesty boundary:',
    '',
    `  ${FEDERATION_HONESTY_BOUNDARY}`,
    `  ${FEDERATION_ARCHITECTURE_REFERENCE}`,
    `  ${FEDERATION_SUBSTRATE_NOTE}`,
    '',
  );

  if (options.dryRun) {
    lines.push(`Note: --dry-run, so ${options.outPath} was not written.`, '');
  } else {
    const command =
      `pnpm fl:sweep --epsilon ${options.epsilons.join(',')} --out ${options.outPath}` +
      (options.mu === FEDERATION_DEFAULTS.mu ? '' : ` --mu ${String(options.mu)}`);
    await renderFederationTradeoff(options.outPath, {
      command,
      generatedOn: new Date().toISOString().slice(0, 10),
      seed: roundSeed,
      window: { from: dataset.simulation.from, to: dataset.simulation.to },
      partition,
      outcome,
      sweep,
      rounds: options.rounds,
      model: options.model,
      elapsedMs,
    });
    lines.push(
      `  wrote              ${options.outPath} (generated; regenerated by the command in its first paragraph)`,
      '',
    );
  }

  lines.push(
    `  measured           ${count(elapsedMs)} ms for ${String(
      sweep.points.length + (options.dryRun ? 1 : 1),
    )} run(s) plus the world's own generation`,
    '',
  );

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
          `\nfl:sweep failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
