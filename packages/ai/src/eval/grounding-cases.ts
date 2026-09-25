import { alertSchema } from '@civora/domain';
import type { AdvisoryDraft, Alert, Fact } from '@civora/domain';

import { advisoryFactsOf, advisorySchemaFor } from '../advisory';
import { numeralsIn } from '../grounding';

/**
 * The grounding assertion, run as an evaluation rather than as a unit test.
 *
 * `pnpm test` already holds the rule on a handful of hand-picked cases. This is
 * the phase's other requirement: an **adversarially injected alert**, whose facts
 * take the shapes that make a numeral check hard — a seven-digit figure that is
 * easy to mis-group, a negative change that is easy to report as a magnitude, a
 * decimal that prose cannot resist rounding — and a case set that says, for each
 * shape, which drafts a reader may be shown and which must be refused.
 *
 * Every case is a *pair*: a text that must be admitted, or a text that must be
 * refused together with the numeral the refusal has to name. Naming the numeral
 * is the strict half and the reason this is worth running: a refusal that says
 * only "invalid" would be a refusal that could be produced by a typo.
 *
 * Two controls keep it from passing vacuously, because a check that accepts
 * everything and a check that rejects everything both look like a green run:
 *
 *  - **The vacuity control.** Every accepted case is re-run with a seven-digit
 *    figure appended that the facts cannot contain. If an accepted text is still
 *    accepted once a number nobody measured is in it, the acceptance above proved
 *    nothing and the evaluation fails.
 *  - **The demonstration.** The phase requires the rule to be shown *failing* on
 *    a deliberately ungrounded draft, so one is injected by name and the report
 *    carries the sentences the rule produced for it. It is not a hypothetical:
 *    the draft is the shape an unconstrained model answers an alert with — a
 *    number of days and an order quantity, neither of which the platform
 *    computed.
 */

/** A numeral no fact in the injected alert can carry, used as the vacuity probe. */
export const VACUITY_PROBE = '424242';

/**
 * The alert the cases are checked against.
 *
 * Its facts are unusual on purpose. A demonstration alert whose figures are all
 * small integers and all positive would exercise the rule about as well as no
 * alert at all: grouping, sign and decimal agreement are exactly where a
 * numeral check earns its keep.
 */
export function adversarialAlert(): Alert {
  return alertSchema.parse({
    id: 'alert-adversarial',
    facilityId: 'facility-khed',
    itemId: 'item-paracetamol-500',
    raisedOn: '2026-09-24',
    severity: 'high',
    state: 'raised',
    bodies: { en: 'PHC Khed · Paracetamol' },
    riskScoreId: 'score-adversarial',
    dedupeKey: 'facility-khed::item-paracetamol-500::shelf',
    facts: [
      { name: 'daysOfStock', value: 4 },
      { name: 'leadTimeDays', value: 9 },
      { name: 'riskIndex', value: 0.985 },
      { name: 'changeSinceLastWeek', value: -12.5 },
      { name: 'ledgerEntries', value: 1042492 },
    ],
    drivers: [
      { driver: 'daysOfStock', contribution: 0.42, detail: 'a 4-day shelf against a 9-day wait' },
      { driver: 'leadTime', contribution: 0.31, detail: 'nine days between an order and a shelf' },
    ],
    history: [],
    acknowledgedBy: null,
    acknowledgedByRole: null,
    acknowledgedAt: null,
    resolvedAt: null,
    synthetic: true,
    provenance: { kind: 'simulated', reference: 'simulator' },
  });
}

/** One draft to check, and what the rule must do with it. */
export interface GroundingCase {
  readonly id: string;
  /** What shape this case injects, in the terms of the fact it stresses. */
  readonly why: string;
  readonly body: string;
  /** Extra reader-visible sentences, checked the same way the body is. */
  readonly reasoning?: readonly string[];
  readonly expectation: 'accepted' | 'refused';
  /** For a refusal: the numerals the rule's own sentence must name. */
  readonly numerals?: readonly string[];
}

/**
 * The case set.
 *
 * The accepted cases are not padding. Each one is a way a *correct* advisory is
 * written that a naive check would refuse — grouping separators, a sign, a
 * seven-digit figure, a phrase that names no numeral at all — and a rule that
 * refuses correct prose is a rule that would be switched off in production.
 */
export const GROUNDING_CASES: readonly GroundingCase[] = [
  {
    id: 'grouped-thousands',
    why: 'a seven-digit quantity written with the separators a reader uses',
    body: 'The district ledger holds 1,042,492 entries, every one of them simulated.',
    expectation: 'accepted',
  },
  {
    id: 'exact-decimal',
    why: 'a three-place decimal quoted exactly as the engine measured it',
    body: 'The risk index stands at 0.985 for this pair.',
    expectation: 'accepted',
  },
  {
    id: 'small-numbers',
    why: 'the two small integers a sentence about this alert actually needs',
    body: 'A 4-day shelf sits against a 9-day wait for this item.',
    expectation: 'accepted',
  },
  {
    id: 'signed-delta',
    why: 'a negative change reported with its sign, which is how the fact states it',
    body: 'Demand has moved -12.5 per cent since last week.',
    expectation: 'accepted',
  },
  {
    id: 'numbers-in-words',
    why: 'a writer that names no figure at all, which is always admissible',
    body: 'Stock is short of the wait for the next delivery, and demand has fallen.',
    expectation: 'accepted',
  },
  {
    id: 'rounded-decimal',
    why: 'the same decimal rounded in prose — arithmetic, not transcription',
    body: 'The risk index stands at 0.99 for this pair.',
    expectation: 'refused',
    numerals: ['0.99'],
  },
  {
    id: 'dropped-sign',
    why: 'a fall reported as a rise: every digit right, the direction wrong',
    body: 'Demand has risen by 12.5 per cent since last week.',
    expectation: 'refused',
    numerals: ['12.5'],
  },
  {
    id: 'converted-percentage',
    why: 'a probability turned into a percentage by the writer',
    body: 'There is a 98.5 per cent chance of a stock-out here.',
    expectation: 'refused',
    numerals: ['98.5'],
  },
  {
    id: 'mis-grouped-thousands',
    why: 'a lakh-grouped figure one digit short of the measured one',
    body: 'The district ledger holds 1,04,492 entries.',
    expectation: 'refused',
    numerals: ['104492'],
  },
];

/**
 * The draft an unconstrained model produces, kept as a named artefact.
 *
 * It is the standard failure this whole rule exists for: a plausible number of
 * days and a plausible order quantity, neither of which the platform computed,
 * in a sentence that reads exactly like the ones that should be published.
 */
export const UNGROUNDED_DEMONSTRATION = {
  why: 'the same request asked without the rule — a confident sentence with two invented figures',
  body: 'PHC Khed will run out of Paracetamol in 11 days. Place an order for 240 strips today.',
} as const;

export interface GroundingCaseResult {
  readonly id: string;
  readonly why: string;
  readonly expectation: 'accepted' | 'refused';
  readonly outcome: 'accepted' | 'refused';
  /** Whether the rule did what the case says it must. */
  readonly held: boolean;
  /** The rule's own sentences: empty when it accepted the draft. */
  readonly problems: readonly string[];
  /** The numerals the case requires the refusal to name. */
  readonly required: readonly string[];
  /**
   * Whether an accepted case stops being accepted once a figure the facts cannot
   * contain is put in it. `undefined` for a case that was expected to be refused.
   */
  readonly vacuityHeld: boolean | undefined;
}

export interface GroundingReport {
  readonly alertId: string;
  readonly facts: readonly Fact[];
  readonly cases: readonly GroundingCaseResult[];
  readonly demonstration: {
    readonly why: string;
    readonly body: string;
    readonly refused: boolean;
    readonly problems: readonly string[];
  };
  /** True when every case, every control and the demonstration behaved as stated. */
  readonly passed: boolean;
}

/** The draft a case is checked as: the alert's own advisory, with the case's text. */
function draftFor(alert: Alert, body: string, reasoning: readonly string[]): AdvisoryDraft {
  return {
    language: 'en',
    title: `${alert.facilityId} · ${alert.itemId}`,
    body,
    actions: ['Place the order today'],
    reasoning: [...reasoning],
    citations: advisoryFactsOf(alert).map((fact) => fact.key),
  };
}

/** What the rule says about one body, as sentences. */
function problemsFor(alert: Alert, body: string, reasoning: readonly string[]): readonly string[] {
  const result = advisorySchemaFor(advisoryFactsOf(alert)).safeParse(
    draftFor(alert, body, reasoning),
  );

  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

/** The numerals a set of sentences contains, for a report that names them. */
function numeralsInTexts(texts: readonly string[]): readonly string[] {
  return [...new Set(texts.flatMap((text) => numeralsIn(text)))];
}

/**
 * Run the case set, and the two controls that stop it passing for the wrong
 * reason.
 *
 * Deterministic and offline: it injects facts and checks a rule, and it neither
 * calls a model nor needs a key. What it cannot tell you is whether a model
 * writes grounded prose — that is what the live attempt the command prints beside
 * this is for.
 */
export function evaluateGrounding(alert: Alert = adversarialAlert()): GroundingReport {
  const facts = advisoryFactsOf(alert);
  const reasoning = ['The engine measured this pair against its own history'];

  const cases = GROUNDING_CASES.map((groundingCase): GroundingCaseResult => {
    const reasoningTexts = groundingCase.reasoning ?? reasoning;
    const problems = problemsFor(alert, groundingCase.body, reasoningTexts);
    const outcome = problems.length === 0 ? 'accepted' : 'refused';
    const held = outcome === groundingCase.expectation;
    const required = groundingCase.numerals ?? [];
    const named = required.every((numeral) =>
      problems.some((problem) => problem.includes(numeral)),
    );

    // A refusal that does not name the figure it refused is a refusal a bug could
    // produce, so naming it is part of what "refused" means here.
    const vacuityHeld =
      groundingCase.expectation === 'accepted'
        ? problemsFor(alert, `${groundingCase.body} ${VACUITY_PROBE}`, reasoningTexts).some(
            (problem) => problem.includes(VACUITY_PROBE),
          )
        : undefined;

    return {
      id: groundingCase.id,
      why: groundingCase.why,
      expectation: groundingCase.expectation,
      outcome,
      held: held && named,
      problems,
      required,
      vacuityHeld,
    };
  });

  // The demonstration draft is otherwise well-formed on purpose: the only thing
  // wrong with it must be the figures nobody measured, or the refusal would prove
  // the schema works rather than the grounding rule.
  const demonstrationProblems = problemsFor(alert, UNGROUNDED_DEMONSTRATION.body, reasoning);
  const demonstration = {
    why: UNGROUNDED_DEMONSTRATION.why,
    body: UNGROUNDED_DEMONSTRATION.body,
    refused: demonstrationProblems.length > 0,
    problems: demonstrationProblems,
  };

  return {
    alertId: alert.id,
    facts,
    cases,
    demonstration,
    passed:
      cases.every((result) => result.held && result.vacuityHeld !== false) &&
      demonstration.refused &&
      numeralsInTexts([demonstration.body]).every((numeral) =>
        demonstration.problems.some((problem) => problem.includes(numeral)),
      ),
  };
}

/** The run, as a person reads it. */
export function renderGroundingReport(report: GroundingReport): string {
  const lines: string[] = [
    '',
    'Grounding: every numeral in prose has to be a numeral the facts carry',
    `  alert              ${report.alertId} (injected for this evaluation, not a record)`,
    `  facts              ${report.facts.map((fact) => `${fact.key}=${String(fact.value)}`).join(' · ')}`,
    `  cases              ${String(report.cases.length)}`,
    '',
  ];

  for (const result of report.cases) {
    const mark = result.held ? 'ok  ' : 'FAIL';
    const control =
      result.expectation === 'accepted'
        ? result.vacuityHeld === true
          ? ' · rejected once a measured number was invented into it'
          : ' · ACCEPTED EVEN WITH AN INVENTED NUMBER IN IT'
        : '';
    lines.push(
      `  ${mark} ${result.expectation.padEnd(8)} ${result.id}${control}`,
      `       ${result.why}`,
    );
    for (const problem of result.problems) {
      lines.push(`       → ${problem}`);
    }
  }

  lines.push(
    '',
    'The rule against a draft written without it:',
    `  “${report.demonstration.body}”`,
    `  ${report.demonstration.why}`,
  );
  for (const problem of report.demonstration.problems) {
    lines.push(`  → ${problem}`);
  }
  lines.push(
    '',
    `  ${report.demonstration.refused ? 'refused' : 'NOT REFUSED'} — ${
      report.demonstration.refused
        ? 'the numerals above are in the prose and in no fact, so the draft cannot be published'
        : 'an ungrounded draft was accepted, which is the failure this check exists to catch'
    }`,
    '',
    report.passed
      ? 'PASS — every case behaved as stated, every accepted case failed once a figure was invented into it, and the deliberate draft was refused.'
      : 'FAIL — at least one case did not behave as stated; see the lines above.',
    '',
    'What this does not measure: whether a model writes grounded prose. That is the live',
    'attempt below, and with no key configured the writer refuses rather than answers.',
    '',
  );

  return lines.join('\n');
}
