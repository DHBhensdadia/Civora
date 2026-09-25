import { alertSchema, epidemicEventSchema, forecastSchema, riskScoreSchema } from '@civora/domain';
import { InMemoryDataProvider } from '@civora/domain';
import {
  DEMO_HISTORY_FACILITIES_PER_REGION,
  DEMO_NETWORK_OPTIONS,
  DEMO_SEED,
  ITEMS,
  buildNetwork,
  historySample,
  scorePopulation,
  simulateNetwork,
} from '@civora/simulator';

/**
 * `pnpm worker:score` — the batch job that fills the intelligence surfaces.
 *
 * Runs the whole pipeline over the demonstration profile: detect syndromic
 * surges, forecast every facility-item pair with censored demand corrected, lift
 * the forecasts a surge touches, score nine drivers, raise alerts, deduplicate
 * them, and write the lot through the persistence port.
 *
 * It is a batch job and not a request handler for one reason that is worth
 * stating: the forecast for a pair does not depend on who is asking. Computing it
 * per request would fit the same series hundreds of times a day, and — worse —
 * would let two officers looking at the same district see two different numbers
 * because the batch that filled each was run on a different day. The scored
 * population has an `asOf`, and everything on screen is from the same one.
 *
 * The pipeline itself lives in `@civora/simulator` because the intelligence
 * surface runs the same code over the same dataset; this command adds parsing,
 * persistence and a summary. The output is printed as well as written, because a
 * job whose only evidence is documents in a store is a job nobody can check.
 */

const USAGE = `
Forecast, score and alert across the demonstration profile, then persist the result.

  pnpm worker:score [options]

Options
  --profile <demo|national>   network coverage (default: demo)
  --seed <value>              generation seed (default: ${DEMO_SEED})
  --horizon <days>            scoring horizon (default: 14)
  --dry-run                   compute and report, write nothing
  --limit <n>                 score at most this many pairs (default: all)
  --help                      print this message

Every figure is simulated. The job reads nothing from the network and needs no
credentials; it writes through the same persistence port the platform uses.
`.trim();

class UsageError extends Error {}

interface Options {
  readonly profile: 'demo' | 'national';
  readonly seed: string;
  readonly horizonDays: number;
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

  const known = new Set(['--profile', '--seed', '--horizon', '--limit', '--dry-run']);
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

  const limit = flags.get('--limit');

  return {
    profile,
    seed: flags.get('--seed') ?? DEMO_SEED,
    horizonDays: whole('--horizon', 14),
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
    limit: options.limit,
  });

  const assessments = scored.assessments;
  const forecasts = assessments.map((assessment) => assessment.forecast);
  const risks = assessments.map((assessment) => assessment.risk);
  const raised = scored.alerts;
  const events = scored.epidemicEvents;

  const bandCounts = new Map<string, number>();
  for (const risk of risks) {
    bandCounts.set(risk.band, (bandCounts.get(risk.band) ?? 0) + 1);
  }

  const facilityNameOf = new Map(
    network.facilities.map((facility) => [facility.id as string, facility.name]),
  );
  const itemById = new Map(ITEMS.map((item) => [item.id as string, item]));

  let written = { forecasts: 0, riskScores: 0, alerts: 0, epidemicEvents: 0 };
  if (!options.dryRun) {
    const provider = new InMemoryDataProvider();
    const forecastRef = provider.collection('forecasts', forecastSchema);
    const riskRef = provider.collection('riskScores', riskScoreSchema);
    const alertRef = provider.collection('alerts', alertSchema);
    const eventRef = provider.collection('epidemicEvents', epidemicEventSchema);

    for (const forecast of forecasts) {
      await forecastRef.set(`${forecast.facilityId}:${forecast.itemId}:${forecast.asOf}`, forecast);
    }
    for (const risk of risks) {
      await riskRef.set(`${risk.facilityId}:${risk.itemId}:${risk.asOf}`, risk);
    }
    for (const alert of raised) {
      await alertRef.set(alert.id, alert);
    }
    for (const event of events) {
      await eventRef.set(event.id, event);
    }
    await provider.close();

    written = {
      forecasts: forecasts.length,
      riskScores: risks.length,
      alerts: raised.length,
      epidemicEvents: events.length,
    };
  }

  const lines = [
    '',
    `Scored ${String(assessments.length)} facility-item pairs at ${scored.asOf}`,
    `  profile            ${options.profile} · scenario ${simulation.scenario.id} · seed ${options.seed}`,
    `  horizon            ${String(scored.horizonDays)} days`,
    `  epidemic events    ${String(events.length)} detected across ${String(
      scored.surgingFacilities,
    )} facilities`,
    `  forecasts lifted   ${String(scored.liftedForecasts)} by a surge`,
    `  bands              ${[...bandCounts]
      .sort()
      .map(([band, count]) => `${band} ${String(count)}`)
      .join(' · ')}`,
    `  alerts raised      ${String(raised.length)} after deduplication`,
    options.dryRun
      ? '  written            nothing (--dry-run)'
      : `  written            ${String(written.forecasts)} forecasts, ${String(
          written.riskScores,
        )} risk scores, ${String(written.alerts)} alerts, ${String(
          written.epidemicEvents,
        )} epidemic events`,
    `  elapsed            ${String(Date.now() - startedAt)} ms`,
    '',
    // Ordered by the composite index, which is what ranks; the measured
    // probability is shown beside it and left blank when no forecast produced one.
    'The highest-scoring pairs (ranked by risk index), with the driver that put them there:',
    ...[...assessments]
      .sort((left, right) => right.risk.riskIndex - left.risk.riskIndex)
      .slice(0, 8)
      .map((assessment) => {
        const worst = assessment.risk.drivers[0];
        const name = facilityNameOf.get(assessment.facilityId) ?? assessment.facilityId;
        const chance =
          assessment.risk.shortfallProbability === null
            ? '  n/a'
            : `${(assessment.risk.shortfallProbability * 100).toFixed(0).padStart(3)}%`;
        return `  ${assessment.risk.band.padEnd(8)} idx ${assessment.risk.riskIndex.toFixed(
          2,
        )}  from ${chance}  ${name} · ${
          itemById.get(assessment.itemId)?.genericName ?? assessment.itemId
        } — ${worst?.driver ?? 'none'}: ${worst?.detail ?? ''}`;
      }),
    '',
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
          `\nscore failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
