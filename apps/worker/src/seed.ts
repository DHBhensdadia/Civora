import { CivoraError, InMemoryDataProvider } from '@civora/domain';
import type { DataProvider } from '@civora/domain';
import {
  DEMO_HISTORY_FACILITIES_PER_REGION,
  DEMO_NETWORK_OPTIONS,
  DEMO_SEED,
  ITEMS,
  buildNetwork,
  historySample,
  simulateNetwork,
  summariseDataset,
} from '@civora/simulator';
import type { NetworkOptions } from '@civora/simulator';

import { exportDataset } from './export';
import type { ExportFormat } from './export';
import { seedDataProvider } from './seeding';

/**
 * `pnpm db:seed` — generate the demonstration dataset and store it.
 *
 * One command, one published seed, one dataset. The purpose is not convenience:
 * a demonstration that cannot be reproduced by the person reviewing it is a
 * claim rather than evidence, and every figure the platform shows later traces
 * back to a run of this command with a seed the reader can type.
 *
 * The write goes through the persistence port, so the same command seeds this
 * machine's memory and, when the managed adapter lands, a deployment. Seeding
 * is idempotent by addressing: every observation is keyed by its natural
 * identity, so running this twice stores the same documents under the same
 * identifiers and the fingerprint printed at the end does not change.
 */

const USAGE = `
Generate the Civora demonstration dataset and store it through the persistence port.

  pnpm db:seed [options]

Options
  --profile <demo|national>      network coverage (default: demo)
  --seed <value>                 generation seed (default: ${DEMO_SEED})
  --facilities-per-region <n>    facilities to generate a history for in each state
                                 (default: ${String(DEMO_HISTORY_FACILITIES_PER_REGION)})
  --provider <name>              persistence adapter to seed (default: in-memory)
  --export <directory>           also write the dataset to this directory
  --format <json|csv>            export format (default: json)
  --help                         print this message

The dataset is deterministic: the same seed produces the same documents under the
same identifiers, on every machine. Everything it contains is simulated.
`.trim();

/** Raised for a command line the command cannot act on. */
class UsageError extends Error {}

interface Options {
  readonly profile: 'demo' | 'national';
  readonly seed: string;
  readonly facilitiesPerRegion: number;
  readonly provider: string;
  readonly exportDirectory: string | null;
  readonly format: ExportFormat;
}

const KNOWN_FLAGS = new Set([
  '--profile',
  '--seed',
  '--facilities-per-region',
  '--provider',
  '--export',
  '--format',
]);

function parseArguments(argv: readonly string[]): Options {
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
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

  const unknown = [...flags.keys()].filter((flag) => !KNOWN_FLAGS.has(flag));
  if (unknown.length > 0) {
    throw new UsageError(`unknown option ${unknown.join(', ')}`);
  }

  const profile = flags.get('--profile') ?? 'demo';
  if (profile !== 'demo' && profile !== 'national') {
    throw new UsageError(`--profile must be demo or national, not "${profile}"`);
  }

  const facilitiesPerRegion = Number(
    flags.get('--facilities-per-region') ?? String(DEMO_HISTORY_FACILITIES_PER_REGION),
  );
  if (!Number.isInteger(facilitiesPerRegion) || facilitiesPerRegion < 1) {
    throw new UsageError('--facilities-per-region must be a whole number of at least one');
  }

  const format = flags.get('--format') ?? 'json';
  if (format !== 'json' && format !== 'csv') {
    throw new UsageError(`--format must be json or csv, not "${format}"`);
  }

  return {
    profile,
    seed: flags.get('--seed') ?? DEMO_SEED,
    facilitiesPerRegion,
    provider: flags.get('--provider') ?? 'in-memory',
    exportDirectory: flags.get('--export') ?? null,
    format,
  };
}

function createDataProvider(kind: string): DataProvider {
  if (kind === 'in-memory') {
    return new InMemoryDataProvider();
  }
  throw new UsageError(
    `the "${kind}" data adapter is not part of this build; use --provider in-memory`,
  );
}

/**
 * Counts are grouped the way a reader in the deployment's home country reads
 * them, matching the interface. A hundred and seventy thousand ledger entries
 * is `1,73,564` here and `173,564` elsewhere, and the platform is deployed in
 * the former.
 */
const number = (value: number): string => value.toLocaleString('en-IN');

function report(lines: readonly (readonly [string, string])[]): void {
  const width = lines.reduce((widest, [label]) => Math.max(widest, label.length), 0);
  for (const [label, value] of lines) {
    process.stdout.write(`  ${label.padEnd(width)}  ${value}\n`);
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const provider = createDataProvider(options.provider);

  const networkOptions: NetworkOptions =
    options.profile === 'national'
      ? { ...DEMO_NETWORK_OPTIONS, coverage: 'all' }
      : DEMO_NETWORK_OPTIONS;

  const network = buildNetwork(networkOptions);
  const facilityIds = historySample(network, options.facilitiesPerRegion);
  const generatedAt = Date.now();
  const simulation = simulateNetwork(network, { seed: options.seed, facilityIds });
  const generationMs = Date.now() - generatedAt;
  const summary = summariseDataset(network, simulation);

  const seeded = await seedDataProvider(provider, { network, simulation, items: ITEMS });

  process.stdout.write('\nCivora dataset seed\n\n');
  report([
    ['seed', options.seed],
    ['scenario', `${simulation.scenario.id} — ${simulation.scenario.label}`],
    [
      'profile',
      `${options.profile} · ${number(network.regions.length)} states · ${number(network.districts.length)} districts · ${number(network.facilities.length)} facilities`,
    ],
    ['window', `${simulation.from} → ${simulation.to} (${number(summary.window.days)} days)`],
    [
      'history for',
      `${number(simulation.counts.facilities)} facilities · ${number(simulation.counts.itemHistories)} item histories`,
    ],
    ['adapter', provider.kind],
  ]);

  process.stdout.write('\n');
  report(seeded.collections.map((entry) => [entry.collection, number(entry.documents)]));
  report([
    ['documents', number(seeded.documents)],
    ['fingerprint', seeded.fingerprint],
  ]);

  process.stdout.write('\n');
  report([
    ['generated in', `${number(generationMs)} ms`],
    ['seeded in', `${number(seeded.elapsedMs)} ms`],
  ]);

  process.stdout.write(
    '\nEvery document is simulated. Re-running this command writes the same identifiers\n' +
      'and prints the same fingerprint.\n',
  );

  if (options.exportDirectory !== null) {
    const written = await exportDataset({
      directory: options.exportDirectory,
      format: options.format,
      seed: options.seed,
      scenarioId: simulation.scenario.id,
      report: seeded,
      network,
      items: ITEMS,
      simulation,
    });
    process.stdout.write(
      `\nExported ${number(written.length)} file(s) to ${options.exportDirectory}\n`,
    );
    for (const path of written) {
      process.stdout.write(`  ${path}\n`);
    }
  }

  return 0;
}

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exitCode = 0;
} else {
  try {
    process.exitCode = await run(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`\n${error.message}\n\n${USAGE}\n`);
      process.exitCode = 2;
    } else {
      const message =
        error instanceof CivoraError || error instanceof Error ? error.message : String(error);
      process.stderr.write(`\nseeding failed: ${message}\n`);
      process.exitCode = 1;
    }
  }
}
