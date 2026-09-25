import {
  advisoryLanguagesOf,
  generateAdvisories,
  selectReasoningProvider,
  withAdvisoryBodies,
} from '@civora/ai';
import { alertSchema, InMemoryDataProvider } from '@civora/domain';
import { languageLabelOf } from '@civora/i18n';
import {
  DEMO_HISTORY_FACILITIES_PER_REGION,
  DEMO_NETWORK_OPTIONS,
  DEMO_SEED,
  buildNetwork,
  historySample,
  scorePopulation,
  simulateNetwork,
} from '@civora/simulator';

/**
 * `pnpm worker:advisories` — the body-writing batch step.
 *
 * The phase's requirement is that an advisory exists **before** anybody opens a
 * screen: a demonstration, or a district, whose explanation arrives only when a
 * judge clicks is one that fails when the quota does. So this command takes the
 * alert set the score job raises and writes a grounded body for every language
 * each alert's record carries, then reports exactly what it got — including, in
 * this build, that nothing was written because no model is configured.
 *
 * What it prints is the evidence, and a refusal is part of that evidence rather
 * than a failure to hide: `0 written, 6 refused` with the provider's own sentence
 * beside each refusal is the true state of this platform today, and it is the
 * state that changes the moment **B2** clears and the same command runs against a
 * real key. Nothing else in the command changes when it does.
 *
 * The same pipeline the surface runs, in the same order, because the bodies must
 * belong to the alerts a reader will see: `scorePopulation` raises the alerts,
 * `advisoryLanguagesOf` reads the languages off those records, and
 * `withAdvisoryBodies` puts back only the languages a draft was actually written
 * for.
 */

const USAGE = `
Write an advisory body per language for the demonstration alert set, ahead of the burst.

  pnpm worker:advisories [options]

Options
  --profile <demo|national>   network coverage (default: demo)
  --seed <value>              generation seed (default: ${DEMO_SEED})
  --horizon <days>            scoring horizon (default: 14)
  --languages <a,b>           languages to write for (default: the ones the records carry)
  --limit <n>                 score at most this many pairs (default: all)
  --dry-run                   write nothing; report what would be written
  --help                      print this message

Every figure is simulated and every body is written from the alert's own facts.
With no reasoning provider configured the fixture adapter refuses each request, and
that refusal is reported rather than hidden. Needs no credentials to run.
`.trim();

class UsageError extends Error {}

interface Options {
  readonly profile: 'demo' | 'national';
  readonly seed: string;
  readonly horizonDays: number;
  readonly languages: readonly string[] | null;
  readonly limit: number | null;
  readonly dryRun: boolean;
}

function parseArguments(argv: readonly string[]): Options {
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === '--dry-run') {
      flags.set('--dry-run', 'yes');
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
    '--profile',
    '--seed',
    '--horizon',
    '--languages',
    '--limit',
    '--dry-run',
  ]);
  const unknown = [...flags.keys()].filter((flag) => !known.has(flag));
  if (unknown.length > 0) {
    throw new UsageError(`unknown option ${unknown.join(', ')}`);
  }

  const profile = flags.get('--profile') ?? 'demo';
  if (profile !== 'demo' && profile !== 'national') {
    throw new UsageError(`--profile must be demo or national, not "${profile}"`);
  }

  const whole = (flag: string, fallback: number): number => {
    const raw = flags.get(flag);
    if (raw === undefined) {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new UsageError(`${flag} must be a whole number of at least one`);
    }
    return value;
  };

  const languages = flags.get('--languages');
  const limit = flags.get('--limit');

  return {
    profile,
    seed: flags.get('--seed') ?? DEMO_SEED,
    horizonDays: whole('--horizon', 14),
    languages:
      languages === undefined
        ? null
        : languages
            .split(',')
            .map((language) => language.trim())
            .filter((language) => language !== ''),
    limit: limit === undefined ? null : whole('--limit', 1),
    dryRun: flags.get('--dry-run') === 'yes',
  };
}

async function run(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const startedAt = Date.now();

  const network = buildNetwork(
    options.profile === 'national'
      ? { ...DEMO_NETWORK_OPTIONS, coverage: 'all' }
      : DEMO_NETWORK_OPTIONS,
  );
  const facilityIds = historySample(network, DEMO_HISTORY_FACILITIES_PER_REGION);
  const simulation = simulateNetwork(network, { seed: options.seed, facilityIds });
  const scored = scorePopulation(simulation, network, {
    horizonDays: options.horizonDays,
    ...(options.limit === null ? {} : { limit: options.limit }),
  });

  const alerts = scored.alerts;
  const languages = options.languages ?? advisoryLanguagesOf(alerts);
  const provider = selectReasoningProvider({
    provider: process.env.CIVORA_REASONING_PROVIDER,
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
  });

  const attempts = await generateAdvisories(provider, { alerts, languages });
  const written = attempts.filter((attempt) => attempt.status === 'written');
  const refused = attempts.filter((attempt) => attempt.status === 'refused');

  let stored = 0;
  if (!options.dryRun) {
    const store = new InMemoryDataProvider();
    const alertRef = store.collection('alerts', alertSchema);

    for (const alert of alerts) {
      const merged = withAdvisoryBodies(alert, attempts);
      if (merged !== alert) {
        await alertRef.set(merged.id, merged);
        stored += 1;
      }
    }
    await store.close();
  }

  const lines = [
    '',
    `Advisories for ${String(alerts.length)} alert(s) at ${scored.asOf}`,
    `  profile            ${options.profile} · scenario ${simulation.scenario.id} · seed ${options.seed}`,
    `  writer             ${provider.kind}${
      provider.kind === 'fixture' ? ' (refuses every request: no key configured)' : ''
    }`,
    `  languages          ${
      languages.length === 0
        ? 'none — no alert record carries a body language'
        : languages.map((code) => `${languageLabelOf(code)} (${code})`).join(' · ')
    }`,
    `  attempted          ${String(attempts.length)}`,
    `  written            ${String(written.length)}`,
    `  refused            ${String(refused.length)}`,
    options.dryRun
      ? '  stored             nothing (--dry-run)'
      : `  stored             ${String(stored)} alert(s) with a new body`,
    `  elapsed            ${String(Date.now() - startedAt)} ms`,
    '',
    ...(written.length === 0 && refused.length > 0
      ? [
          'Every attempt was refused, so no body was replaced. The alerts keep the bodies they',
          'were raised with, and the refusals are reported below rather than hidden:',
          ...refused
            .slice(0, 6)
            .map((attempt) => `  ${attempt.language}: ${attempt.refusal ?? ''}`),
          '',
        ]
      : []),
    'Bodies retrieved from a model are grounded: a numeral in them that the alert’s own facts do',
    'not carry is refused before it can reach a record. A refusal above therefore means the alert',
    'keeps the body it had — never that it lost one.',
    '',
    ...(options.dryRun
      ? ['Note: --dry-run read the alert set and computed the bodies, and wrote nothing.', '']
      : [
          'Note: this command writes to its own process’s store, as `worker:score` does. The served',
          '      application builds the demonstration dataset itself; a durable store is Phase 9/10.',
          '',
        ]),
  ];

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
          `\nadvisories failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
