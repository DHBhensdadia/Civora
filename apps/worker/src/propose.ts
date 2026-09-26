import { InMemoryDataProvider, transferProposalSchema } from '@civora/domain';
import {
  DEFAULT_SCENARIO_ID,
  DEMO_HISTORY_FACILITIES_PER_REGION,
  DEMO_SEED,
  ITEMS,
  buildDemoDataset,
  planWorld,
  projectSimulation,
  requireScenario,
  scoredPopulationFor,
} from '@civora/simulator';

import { digestFactsOf, digestOf } from './plan-digest';
import type { PlanDigestDataset } from './plan-digest';
import { renderPlanReport } from './plan-report';

/**
 * `pnpm worker:propose` — the batch step that recomputes Setu's plan.
 *
 * The phase asks for the optimiser to be wired to the batch worker so proposals
 * are refreshed as risk changes, and for a determinism claim that survives a
 * process restart. This command is both. It rebuilds the demonstration world
 * from its published seed, runs the identical pipeline the workbench runs —
 * `scoredPopulationFor` → `projectSimulation` → `planWorld`, every one of them
 * in `@civora/simulator` so a surface plan and a batch plan cannot be two
 * computations — writes the proposals it produces through the persistence port,
 * and prints a digest of the plan so two invocations can be compared byte for
 * byte by a reader or a CI step. No vitest file can supply a restart; this can.
 *
 * Two things it deliberately does not do, stated because a reader would
 * otherwise assume them:
 *
 *  - **It executes nothing.** A transfer is a proposal a person decides on. This
 *    command produces the proposals; the decision is taken on the workbench, by
 *    somebody with the authority for it, and recorded in the audit chain with a
 *    reason. Auto-execution is out of the phase's scope on purpose.
 *  - **It does not reach into the served application.** The plan the workbench
 *    shows is memoised per server process, which is what makes a five-second
 *    poll cheap; with the in-memory adapter the two processes hold their own
 *    stores, so what this command refreshes is the batch's own copy of the
 *    record, and the page says so. The wiring is identical against a durable
 *    store (Phase 9/10): `planWorld` over a world the caller supplies.
 */

const USAGE = `
Recompute Setu's redistribution plan over the demonstration dataset, write the proposals it
produces, and print a digest of the plan.

  pnpm worker:propose [options]

Options
  --profile <demo>    network coverage; the demonstration profile is the only one this
                      command computes (default: demo)
  --scenario <id>     scenario to perturb the generated world with (default: ${DEFAULT_SCENARIO_ID});
                      "no-transfer-warranted" is the phase's negative control
  --seed <value>      generation seed (default: ${DEMO_SEED})
  --digest-only       print only the plan digest, for comparing two runs
  --report <path>     also write the plan, its proposals and its assumptions as markdown
  --dry-run           compute and report, write nothing
  --help              print this message

Every figure is simulated; the command reads nothing from the network and needs no
credentials. Nothing here executes a transfer: a transfer is a proposal a person decides on.
`.trim();

class UsageError extends Error {}

interface Options {
  readonly scenarioId: string;
  readonly seed: string;
  readonly digestOnly: boolean;
  readonly reportPath: string | null;
  readonly dryRun: boolean;
}

function parseArguments(argv: readonly string[]): Options {
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === '--dry-run' || argument === '--digest-only') {
      flags.set(argument, 'yes');
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
    '--scenario',
    '--seed',
    '--digest-only',
    '--report',
    '--dry-run',
  ]);
  const unknown = [...flags.keys()].filter((flag) => !known.has(flag));
  if (unknown.length > 0) {
    throw new UsageError(`unknown option ${unknown.join(', ')}`);
  }

  const profile = flags.get('--profile') ?? 'demo';
  if (profile !== 'demo') {
    throw new UsageError(
      `this command computes the demonstration profile only, not "${profile}"; the national network's plan is not a batch this build attempts`,
    );
  }

  const seed = flags.get('--seed') ?? DEMO_SEED;
  if (seed.trim() === '') {
    throw new UsageError('--seed needs a value');
  }

  const scenarioId = flags.get('--scenario') ?? DEFAULT_SCENARIO_ID;
  try {
    requireScenario(scenarioId);
  } catch {
    throw new UsageError(`--scenario names a scenario the simulator does not hold: ${scenarioId}`);
  }

  return {
    scenarioId,
    seed,
    digestOnly: flags.get('--digest-only') === 'yes',
    reportPath: flags.get('--report') ?? null,
    dryRun: flags.get('--dry-run') === 'yes',
  };
}

/** A whole number with Indian digit grouping, so a reader can size it at a glance. */
const count = (value: number): string => value.toLocaleString('en-IN');

const fixed = (value: number, digits = 1): string => value.toFixed(digits);

const ascending = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const ruleCounts = (removed: Readonly<Record<string, number>>): string =>
  Object.entries(removed)
    .filter(([, removedCount]) => removedCount > 0)
    .sort(([left], [right]) => ascending(left, right))
    .map(([rule, removedCount]) => `${rule} ${count(removedCount)}`)
    .join(' · ');

async function run(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const startedAt = Date.now();

  const dataset = buildDemoDataset(
    DEMO_HISTORY_FACILITIES_PER_REGION,
    options.seed,
    options.scenarioId,
  );
  const { network, simulation, summary } = dataset;
  const ledger = projectSimulation(simulation, ITEMS);
  const scored = scoredPopulationFor(simulation, network);
  const facilitiesWithHistory = [...dataset.facilityIds].sort(ascending);

  const plan = await planWorld({
    network,
    simulation,
    catalogue: ITEMS,
    ledger,
    facilitiesWithHistory,
    scored: scored.assessments,
  });
  const plannedInMs = Date.now() - startedAt;

  let written = 0;
  if (!options.dryRun) {
    // Through the port, with the contract's own schema, so a proposal the
    // optimiser could build but the platform could not store fails here rather
    // than on a screen. It is this process's store; see the note printed below.
    const provider = new InMemoryDataProvider();
    const collection = provider.collection('transferProposals', transferProposalSchema);
    for (const proposed of plan.proposals) {
      await collection.set(proposed.proposal.id, proposed.proposal);
    }
    await provider.close();
    written = plan.proposals.length;
  }

  const facilityNames = new Map(
    network.facilities.map((facility) => [facility.id as string, facility.name]),
  );
  const itemNames = new Map(ITEMS.map((item) => [item.id as string, item.genericName]));
  const facilityName = (facilityId: string): string => facilityNames.get(facilityId) ?? facilityId;
  const itemName = (itemId: string): string => itemNames.get(itemId) ?? itemId;

  const datasetFacts: PlanDigestDataset = {
    facilities: network.facilities.length,
    districts: network.districts.length,
    withHistory: facilitiesWithHistory.length,
    items: ITEMS.length,
    ledgerEntries: simulation.ledgerEntries.length,
    from: summary.window.from,
    to: summary.window.to,
    days: summary.window.days,
  };

  const digest = digestOf(
    digestFactsOf(plan, {
      seed: options.seed,
      scenarioId: simulation.scenario.id,
      dataset: datasetFacts,
    }),
  );

  const impact = plan.selection.outcome.impact;
  const marginalOrNegative = impact.transfers.filter(
    (transfer) => transfer.assessment !== 'beneficial',
  );
  const candidates =
    plan.graph.edges.length +
    Object.values(plan.graph.removedByRule).reduce((sum, removed) => sum + removed, 0);

  if (options.reportPath !== null) {
    await renderPlanReport(options.reportPath, {
      plan,
      digest,
      command: `pnpm worker:propose --report ${options.reportPath}`,
      generatedOn: new Date().toISOString().slice(0, 10),
      seed: options.seed,
      scenario: simulation.scenario,
      dataset: datasetFacts,
      facilityName,
      itemName,
    });
  }

  if (options.digestOnly) {
    process.stdout.write(`${digest.text}\n`);
    return 0;
  }

  const lines = [
    '',
    'Setu plan over the demonstration profile — this command’s own computation, and nothing here executes',
    '',
    `  profile            demo · scenario ${simulation.scenario.id} (${simulation.scenario.label}) · seed ${options.seed}`,
    `  as of              ${simulation.to} · history window ${datasetFacts.from} → ${datasetFacts.to} (${String(
      datasetFacts.days,
    )} days) · history for ${count(datasetFacts.withHistory)} of ${count(
      datasetFacts.facilities,
    )} facilities`,
    `  dataset            ${count(datasetFacts.facilities)} facilities · ${count(
      datasetFacts.districts,
    )} districts · ${count(datasetFacts.items)} items · ${count(
      datasetFacts.ledgerEntries,
    )} ledger entries · generated in ${String(dataset.generatedInMs)} ms`,
    `  plan               built in ${String(plannedInMs)} ms`,
    `  graph              ${count(candidates)} candidates → ${count(
      plan.graph.edges.length,
    )} feasible edges${
      ruleCounts(plan.graph.removedByRule) === ''
        ? ''
        : ` (removed: ${ruleCounts(plan.graph.removedByRule)})`
    }`,
    `  receivers          ${count(plan.receivers.ranked.length)} ranked · ${count(
      plan.receivers.unmeasured.length,
    )} unmeasured · ${count(plan.unpositionedReceivers.length)} with no stock position`,
    `  donors             ${count(plan.donors.ranked.length)} eligible · ${count(
      plan.donors.ineligible.length,
    )} ineligible`,
    `  needs              ${count(plan.needs.length)} across ${count(
      plan.demands.length,
    )} receivers · ${count(plan.unserved.length)} unserved`,
    `  strategy           ${plan.selection.name}, chosen by ${
      plan.selection.decidedBy
    } (${String(plan.iterations)} iteration(s), budget ${
      plan.budgetReached ? 'reached' : 'not reached'
    }): ${plan.selection.reason}`,
    `  objective          ${fixed(plan.objective.total)} against a do-nothing baseline of ${fixed(
      plan.baseline.total,
    )} (improvement ${fixed(plan.baseline.total - plan.objective.total)})`,
    `  verdict            ${
      plan.refused.length === 0
        ? 'admitted by the validator'
        : `refused by the validator (${count(plan.refused.length)} violation(s))`
    } · ${count(plan.selection.outcome.verdict.measured.transfers)} transfers · ${count(
      plan.selection.outcome.verdict.measured.units,
    )} units · ${fixed(plan.selection.outcome.verdict.measured.unitKm)} unit-km`,
    `  impact             net benefit ${fixed(
      impact.totalNetBenefit,
      2,
    )} · unmet demand avoided ${fixed(
      impact.totalExpectedUnmetDemandAvoided,
      2,
    )} · stock-out days averted ${fixed(
      impact.totalExpectedStockOutDaysAverted,
      2,
    )} · ${count(marginalOrNegative.length)} marginal or negative · ${count(
      impact.unquantified.length,
    )} unquantified`,
    options.dryRun
      ? '  wrote              nothing (--dry-run)'
      : `  wrote              ${count(written)} proposal(s) through the persistence port, this process’s own store`,
    ...(options.reportPath === null ? [] : [`  report             wrote ${options.reportPath}`]),
    '',
    'The proposals, in the order the plan produced them — a person decides, and nothing executes:',
    '',
  ];

  for (const planned of plan.proposals) {
    const { proposal, transfer, impact: priced } = planned;
    lines.push(
      `  ${proposal.id}`,
      `    ${facilityName(transfer.donorId)} → ${facilityName(transfer.receiverId)} · ${itemName(
        transfer.itemId,
      )} · batch ${proposal.batchId ?? 'none'} · ${count(proposal.quantity)} units · ${fixed(
        transfer.distanceKm,
      )} km · lead ${String(transfer.leadTimeDays)} day(s) · shelf life on arrival ${String(
        transfer.shelfLifeOnArrivalDays,
      )} day(s) · expires ${transfer.expiresOn}`,
      priced === null
        ? '    impact not quantified: no forecast covered this receiver and item, so no figure is claimed'
        : `    impact ${priced.assessment} · avoided ${fixed(
            priced.expectedUnmetDemandAvoided,
            2,
          )} units of demand · net benefit ${fixed(
            priced.netBenefit,
            2,
          )} against a transport cost of ${fixed(priced.transportCost, 4)} · receiver ${fixed(
            proposal.expectedImpact.receiverDaysOfStockAfter,
            1,
          )} day(s) of stock after, donor ${fixed(
            proposal.expectedImpact.donorDaysOfStockAfter,
            1,
          )} day(s)`,
    );
  }

  lines.push(
    '',
    `Strategy attempts the validator refused: ${count(
      plan.selection.refusals.length,
    )}. Violations on the selected plan: ${count(
      plan.refused.length,
    )}. Unserved needs: ${count(plan.unserved.length)}.`,
    '',
    'The digest — the same plan written down the same way every time, so two runs can be compared:',
    '',
    digest.text,
    '',
    options.dryRun
      ? 'Note: --dry-run computed the plan and the digest and wrote nothing, so this run is evidence about the computation and not about a store.'
      : 'Note: this command writes to its own process’s store, as `worker:score` does. The served application builds the demonstration dataset and its plan itself, memoised per server process, so a batch refresh reaches the screen when that process rebuilds; a store a schedule refreshes and the application reads is Phase 9/10.',
    'Note: nothing on this plan is executed by anything. A transfer is a proposal a person decides on, with a reason, and the decision is recorded in the audit chain.',
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
          `\npropose failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
