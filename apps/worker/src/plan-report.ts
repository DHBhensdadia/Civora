import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { PlanObjective, RedistributionPlan } from '@civora/optimizer';

import type { PlanDigest, PlanDigestDataset } from './plan-digest';

/**
 * The redistribution plan, written as a document.
 *
 * Generated rather than hand-written for the reason `evaluation-report.ts` is:
 * a figure in a document that nobody re-derives stops matching the code that
 * produced it, and a reader has no way to tell. Everything below comes from one
 * plan object and one digest, so regenerating the file with the command named in
 * its first paragraph is the same computation a judge would run.
 *
 * The document is written for somebody deciding whether to trust the plan, which
 * is why it carries what is easy to leave out: the scenario and what it expects
 * (including when it expects *nothing*), the strategies that were considered and
 * why one was chosen, the impact's method and assumptions, what the plan could
 * not cover, and a plain statement of what is not on the table — execution, and
 * a model's involvement in any figure.
 */

export interface PlanReportInput {
  readonly plan: RedistributionPlan;
  readonly digest: PlanDigest;
  /** The command a reader types to reproduce this document. */
  readonly command: string;
  readonly generatedOn: string;
  readonly seed: string;
  readonly scenario: {
    readonly id: string;
    readonly label: string;
    readonly expectation: string;
    readonly negativeControl: boolean;
  };
  readonly dataset: PlanDigestDataset;
  readonly facilityName: (facilityId: string) => string;
  readonly itemName: (itemId: string) => string;
}

const BACKTICK = '`';
const FENCE = BACKTICK.repeat(3);

/** An inline code span. Built rather than escaped: a nested template is a trap. */
const code = (value: string): string => `${BACKTICK}${value}${BACKTICK}`;

const count = (value: number): string => value.toLocaleString('en-IN');

const fixed = (value: number, digits = 1): string => value.toFixed(digits);

const money = (value: number): string => fixed(value, 2);

const objective = (value: PlanObjective): string =>
  `unmet demand ${fixed(value.unmetDemandPenalty, 2)} · transport ${fixed(
    value.transportCost,
    4,
  )} · expiry ${fixed(value.expiryPenalty, 2)} · total ${fixed(value.total, 2)}`;

const bullets = (lines: readonly string[]): string => lines.map((line) => `- ${line}`).join('\n');

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');

export async function renderPlanReport(path: string, input: PlanReportInput): Promise<void> {
  const { plan, digest } = input;
  const impact = plan.selection.outcome.impact;
  const measured = plan.selection.outcome.verdict.measured;
  const selected = plan.selection.outcome;

  const scenarioNote = input.scenario.negativeControl
    ? `**This is a negative control.** ${input.scenario.expectation} A plan that found transfers here would be moving stock to create activity rather than to prevent a shortage, so the count of proposals below is the result to read.`
    : input.scenario.expectation;

  // An assumptions list that repeated every proposal's own figures would be a
  // wall of near-duplicates. What is printed is what every proposal shares; the
  // sentences that differ per proposal are counted and named for what they are,
  // because they are still in the record and still on the screen.
  const eachAssumptions = plan.proposals.map(
    (planned) => planned.proposal.expectedImpact.assumptions,
  );
  const sharedAssumptions =
    eachAssumptions.length === 0
      ? []
      : (eachAssumptions[0] ?? []).filter((sentence) =>
          eachAssumptions.every((list) => list.includes(sentence)),
        );
  const perProposalSentences = new Set(
    eachAssumptions.flat().filter((sentence) => !sharedAssumptions.includes(sentence)),
  );
  const assumptionLines = [
    bullets(sharedAssumptions),
    perProposalSentences.size === 0
      ? ''
      : `${String(perProposalSentences.size)} further sentence(s) are per proposal — the units, the distance, the days and the assessment that proposal was projected over. They travel in each record and are shown beside each row on the workbench.`,
  ]
    .filter((section) => section !== '')
    .join('\n\n');

  const proposalTable = table(
    [
      'Proposal',
      'From',
      'To',
      'Item',
      'Batch',
      'Units',
      'Distance',
      'Lead time',
      'Shelf life on arrival',
      'Expires',
      'Impact',
    ],
    plan.proposals.map((planned) => [
      code(planned.proposal.id),
      input.facilityName(planned.transfer.donorId),
      input.facilityName(planned.transfer.receiverId),
      input.itemName(planned.transfer.itemId),
      planned.proposal.batchId ?? '—',
      count(planned.proposal.quantity),
      `${fixed(planned.transfer.distanceKm)} km`,
      `${String(planned.transfer.leadTimeDays)} day(s)`,
      `${String(planned.transfer.shelfLifeOnArrivalDays)} day(s)`,
      planned.transfer.expiresOn,
      planned.impact === null
        ? 'not quantified'
        : `${planned.impact.assessment} (net ${money(planned.impact.netBenefit)})`,
    ]),
  );

  const strategyTable = table(
    ['Strategy', 'Benefit per unit-km', 'Transfers', 'Units', 'Unit-km', 'Validator', 'Chosen'],
    plan.selection.outcomes.map((outcome) => [
      outcome.name,
      fixed(outcome.benefitPerUnitKm, 3),
      count(outcome.plan.transfers.length),
      count(outcome.verdict.measured.units),
      fixed(outcome.verdict.measured.unitKm),
      outcome.acceptable
        ? `admitted (${String(outcome.verdict.unchecked.length)} rule(s) unchecked)`
        : `refused: ${
            outcome.refusal ?? outcome.verdict.violations.map((each) => each.code).join(', ')
          }`,
      outcome.name === plan.selection.name ? 'yes' : '',
    ]),
  );

  const strategyDescriptions = plan.selection.outcomes
    .map((outcome) => `- **${outcome.name}** — ${outcome.description}`)
    .join('\n');

  const refusals =
    plan.selection.refusals.length === 0
      ? 'No attempt was refused before the plan below was selected.'
      : plan.selection.refusals
          .map((refusal) => {
            const codes =
              refusal.violations.length === 0
                ? ''
                : ` (validator codes: ${refusal.violations.map(code).join(', ')})`;
            return `- ${code(refusal.strategy)} was refused: ${refusal.reason}${codes}`;
          })
          .join('\n');

  const refusalTable = table(
    ['Rule', 'Code', 'Detail'],
    plan.refused.map((refusal) => [refusal.rule, refusal.code, refusal.detail]),
  );

  const refusedSection =
    plan.refused.length === 0
      ? ''
      : [
          'The selected plan was refused, and a refused plan produces no proposals for anybody to consider:',
          '',
          refusalTable,
          '',
        ].join('\n');

  const unserved =
    plan.unserved.length === 0
      ? 'Every need the ranking constructed was covered.'
      : [
          `${count(plan.unserved.length)} need(s) could not be covered without taking a donor below its own safety floor:`,
          '',
          table(
            ['Facility', 'Item', 'Units', 'Ranking weight'],
            plan.unserved
              .slice(0, 8)
              .map((need) => [
                input.facilityName(need.facilityId),
                input.itemName(need.itemId),
                count(need.units),
                fixed(need.receiverWeight, 3),
              ]),
          ),
        ].join('\n');

  const unquantified =
    impact.unquantified.length === 0
      ? 'Every proposal was priced against a forecast.'
      : [
          `${count(
            impact.unquantified.length,
          )} proposal(s) carry no impact figure, because no forecast covered the receiver and item. An unmeasured impact is reported as unmeasured, never as zero:`,
          '',
          table(
            ['Receiver', 'Item', 'Why'],
            impact.unquantified
              .slice(0, 8)
              .map((each) => [
                input.facilityName(each.receiverId),
                input.itemName(each.itemId),
                each.reason,
              ]),
          ),
        ].join('\n');

  const marginal =
    impact.marginalOrNegative.length === 0
      ? 'Every priced transfer avoided more than it cost.'
      : [
          `${count(
            impact.marginalOrNegative.length,
          )} priced transfer(s) avoided less than their transport cost, and are reported rather than quietly dropped:`,
          '',
          table(
            ['Transfer', 'Assessment', 'Net benefit'],
            impact.marginalOrNegative.map((each) => [
              code(`${each.donorId} → ${each.receiverId}`),
              each.assessment,
              money(each.netBenefit),
            ]),
          ),
        ].join('\n');

  const assumptionsTable = table(
    ['', ''],
    [
      ['Net benefit', money(impact.totalNetBenefit)],
      [
        'Expected unmet demand avoided',
        `${fixed(impact.totalExpectedUnmetDemandAvoided, 2)} units`,
      ],
      [
        'Expected stock-out days averted',
        `${fixed(impact.totalExpectedStockOutDaysAverted, 2)} days`,
      ],
      ['Transport cost', money(impact.totalTransportCost)],
      [
        'Method',
        `${code(impact.assumptions.method)} over ${impact.assumptions.scenarios.join(
          ' and ',
        )}, horizon ${String(impact.assumptions.horizonDays)} days`,
      ],
      ['Cost per unit-km', fixed(impact.assumptions.costPerUnitKm, 4)],
      [
        'Weighted by a measured shortfall probability',
        impact.assumptions.weightedByShortfallProbability
          ? 'yes'
          : 'no — no forecast measured one for these pairs, so the median path alone was used',
      ],
    ],
  );

  const planSummary = bullets([
    `${count(plan.proposals.length)} proposal(s), ${count(measured.units)} units over ${fixed(
      measured.unitKm,
    )} unit-km.`,
    `Objective ${fixed(plan.objective.total, 2)} against a do-nothing baseline of ${fixed(
      plan.baseline.total,
      2,
    )} — an improvement of ${fixed(
      plan.baseline.total - plan.objective.total,
      2,
    )} on the scale of the request's most urgent receiver. (The objective is scaled per request, so it orders plans over one request and is not comparable between requests.)`,
    `Selected strategy **${plan.selection.name}**, chosen by the ${
      plan.selection.decidedBy
    } after ${String(plan.iterations)} iteration(s)${
      plan.budgetReached ? ', stopping at the iteration budget' : ''
    }, in ${String(plan.improvementPasses)} improvement pass(es), objective ${objective(
      selected.plan.objective,
    )}.`,
    `Validator verdict: ${
      plan.refused.length === 0
        ? `admitted, with ${String(
            selected.verdict.unchecked.length,
          )} rule(s) it could not check because the world did not carry what they need`
        : `refused — ${String(plan.refused.length)} violation(s) listed below`
    }.`,
  ]);

  const constraints = bullets([
    `Transport: ${count(plan.world.transport.budgetUnitKm)} unit-km budget, ${count(
      plan.world.transport.edgeCapacityUnits,
    )} units per edge, ${String(
      plan.world.transport.reactionBufferDays,
    )} day reaction buffer past a projected stock-out.`,
    'No donor is left below its own safety floor, no batch is moved that expires before it lands, no item travels along an edge without cold-chain capability at both ends, and no receiver is topped up beyond the need it was ranked with.',
  ]);

  const provenance = table(
    ['', ''],
    [
      ['Day the plan is made for', plan.world.asOf],
      [
        'Dataset',
        `${count(input.dataset.facilities)} facilities · ${count(
          input.dataset.districts,
        )} districts · ${count(input.dataset.withHistory)} with a generated history · ${count(
          input.dataset.items,
        )} catalogue items`,
      ],
      [
        'History window',
        `${input.dataset.from} → ${input.dataset.to} (${String(
          input.dataset.days,
        )} days), ${count(input.dataset.ledgerEntries)} ledger entries`,
      ],
      ['Scenario', `${code(input.scenario.id)} — ${input.scenario.label}`],
      ['What the scenario expects', scenarioNote],
      ['Plan digest', `${code(digest.hash)} (${code(digest.format)})`],
    ],
  );

  const uncovered = bullets([
    `${count(
      plan.receivers.unmeasured.length,
    )} ranked pair(s) had no measured shortfall probability and are reported rather than ranked.`,
    `${count(
      plan.donors.ineligible.length,
    )} donor pair(s) could not donate: everything they hold is inside the floor they keep for themselves, or no daily demand was ever measured for them.`,
    `${count(
      plan.unpositionedReceivers.length,
    )} scored pair(s) had no stock position at all, so no need could be computed for them; they are listed rather than assumed away.`,
    `${count(plan.graph.unknownFacilities.length)} facility and ${count(
      plan.graph.unknownItems.length,
    )} item named by a lot were unknown to the graph. A lot the graph cannot place is refused, never guessed at.`,
  ]);

  const notThis = bullets([
    `**Not a running system's state.** The store behind this document is the command's own process; the served application builds the same dataset and the same plan itself, and memoises it per server process. A durable store that a schedule refreshes and the application reads is Phase 9/10 work. The computation is identical either way: ${code(
      'planWorld',
    )} over a world the caller supplies.`,
    "**Not a model's output.** Every quantity here comes from the deterministic engines — the feasibility graph, the ranking, the planner, the impact estimator. The strategy layer may select between the weightings above and the rationale writer may explain a proposal; with no API key configured the deterministic fallback does the selecting (blocker B2 in the project state) and every rationale attempt is refused. A refusal to explain is displayed as a refusal, and no number is invented to fill it.",
    '**Not an execution plan.** See the first paragraph.',
  ]);

  const document = [
    '# Setu: the redistribution plan',
    '',
    `Generated by ${code(input.command)} on ${input.generatedOn} over the demonstration dataset at seed ${code(
      input.seed,
    )}, and regenerated by running that command again. The plan digest at the end of this document is what two runs are compared by.`,
    '',
    '**Nothing in this plan is executed by anything.** A transfer is a proposal a person decides on, on the workbench, with a reason, and the decision is recorded in the hash-chained audit trail. The approval is the end of the pipeline; auto-execution is out of scope on purpose.',
    '',
    '## Where this plan comes from',
    '',
    provenance,
    '',
    '## What the plan does',
    '',
    planSummary,
    '',
    refusedSection,
    '## The proposals',
    '',
    plan.proposals.length === 0
      ? 'None. The plan found nothing worth moving, and in this scenario that is the result.'
      : proposalTable,
    '',
    '## The strategies considered',
    '',
    strategyDescriptions,
    '',
    strategyTable,
    '',
    `**Why ${plan.selection.name}:** ${plan.selection.reason}`,
    '',
    refusals,
    '',
    '## The impact, and what it assumes',
    '',
    assumptionsTable,
    '',
    marginal,
    '',
    unquantified,
    '',
    'The assumptions that travel with every proposal, in the record and on the screen:',
    '',
    assumptionLines,
    '',
    '## What the plan could not cover',
    '',
    unserved,
    '',
    uncovered,
    '',
    '## The constraints the plan was held to',
    '',
    constraints,
    '',
    '## What this document is not',
    '',
    notThis,
    '',
    '## The digest',
    '',
    'The canonical block two runs are compared by. Every number is printed at full precision, and the hash is taken over these lines exactly as they appear:',
    '',
    [`${FENCE}text`, digest.text, FENCE].join('\n'),
    '',
  ]
    // A section that was deliberately empty (a refused plan, say) should not
    // leave a hole in the document; the content is what was asked for.
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, document, 'utf8');
}
