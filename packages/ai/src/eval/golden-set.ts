import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { VOICE_PROBLEMS, dateSchema, voiceIntentSchema } from '@civora/domain';
import type { Item, StockExtraction, VoiceCaptureCommand } from '@civora/domain';
import { decideLine, decideVoiceCommand, resolveItem } from '@civora/domain';
import { z } from 'zod';

import { stockExtractionPrompt, voiceCommandPrompt } from '../prompts';
import type { Prompt } from '../prompts';

/**
 * The extraction evaluation: a corpus of labelled readings and the scorer that
 * reports how accurately the reader read them.
 *
 * Two things about this file are the point of it, and both are about not
 * manufacturing evidence.
 *
 *  - **A case is only a case if it was captured from a real call.** The corpus
 *    holds, for one photograph or recording, the response a model actually
 *    returned and the labels a person wrote for the same input. The loader
 *    **refuses a file without provenance** — the command, the day, the model and
 *    the digest of the media the recording belongs to — and it refuses one whose
 *    media is missing or whose digest does not match. A hand-written fixture is
 *    not a weak fixture; it is a fake measurement, and this command exists to
 *    produce measurements.
 *  - **NOT MEASURED is a result.** With no corpus the report says so, states why,
 *    and prints no percentage. A rate over an empty set is the one output that
 *    would make a green CI log mean nothing was checked, which is worse than a red
 *    one. The exit code carries the same three states, and the CI job that runs
 *    this says which of them it accepts.
 *
 * What it scores is what the platform decided, not only what the reader returned:
 * each labelled line is fed through `decideLine` (or, for a recording,
 * `decideVoiceCommand`), so the report answers the operationally interesting
 * question — would this reading have been written, or held for a person? A line
 * written that a person should have decided is counted as a **false accept**, and
 * that count has to be zero. It is not an average and cannot be traded against
 * accuracy: the failure mode this platform cannot absorb is a wrong number in a
 * stock ledger that nobody looked at.
 */

/**
 * What a measured run has to achieve.
 *
 * The accuracy figure is a policy choice and is stated wherever the accuracy is,
 * because a threshold that travels separately from its measurement is a threshold
 * nobody can check. The false-accept ceiling is not a rate: one line written that
 * a person should have decided is a failure, however accurate the other lines
 * were.
 */
export const GOLDEN_THRESHOLDS = {
  fieldAccuracy: 0.95,
  falseAccepts: 0,
} as const;

/** The exit codes, which are part of the contract rather than a detail. */
export const GOLDEN_EXIT_CODES = {
  /** A measurement was made and it met the threshold. */
  passing: 0,
  /** A measurement was made and it did not — or a corpus file could not be read. */
  failing: 1,
  /** Nothing could be measured. Never a pass. */
  notMeasured: 2,
  /** The command was asked for something it does not do. */
  misuse: 3,
} as const;

/** Every field a score is kept for. A dimension with no cases reads *not measured*. */
export const GOLDEN_DIMENSIONS = [
  'item',
  'quantity',
  'batch',
  'expiry',
  'register-date',
  'intent',
  'language',
  'open-questions',
  'routing',
] as const;

export type GoldenDimension = (typeof GOLDEN_DIMENSIONS)[number];

export interface GoldenFieldTally {
  readonly correct: number;
  readonly total: number;
}

/**
 * Where a case's response came from.
 *
 * Required in full. `mediaDigest` is what ties a recording to the media it was
 * captured against: without it a case could pair yesterday's photograph with
 * today's answer and nothing would notice.
 */
export interface GoldenProvenance {
  /** The exact command that obtained the recorded response. */
  readonly command: string;
  /** The day it was captured, ISO. */
  readonly capturedOn: string;
  /** The model that answered, as the provider named it. */
  readonly model: string;
  /** `sha256:` and the digest of the media file the response belongs to. */
  readonly mediaDigest: string;
}

export interface GoldenTolerance {
  readonly by: number;
  readonly reason: string;
}

export interface GoldenExtractionLine {
  /** The catalogue entry the line must resolve to. The label, not a hoped-for name. */
  readonly itemId: string;
  /** How the page wrote it, for a failure message a person can act on. */
  readonly itemName: string;
  readonly quantity: number;
  readonly tolerance: GoldenTolerance | null;
  readonly batchId: string | null;
  readonly expiresOn: string | null;
  /** What the platform must do with the line: write it, or ask a person. */
  readonly routing: 'write' | 'review';
}

export interface GoldenExtractionCase {
  readonly kind: 'stock-extraction';
  readonly id: string;
  readonly task: string;
  readonly provenance: GoldenProvenance;
  /** Absolute path of the photograph the recording belongs to. */
  readonly media: string;
  readonly recorded: StockExtraction;
  readonly expected: {
    readonly registerDate: string | null;
    readonly lines: readonly GoldenExtractionLine[];
  };
}

export interface GoldenVoiceCase {
  readonly kind: 'voice-command';
  readonly id: string;
  readonly task: string;
  readonly provenance: GoldenProvenance;
  /** Absolute path of the recording the parse belongs to. */
  readonly media: string;
  readonly recorded: VoiceCaptureCommand;
  readonly expected: {
    readonly observedOn: string;
    readonly intent: VoiceCaptureCommand['intent'];
    readonly itemId: string | null;
    readonly quantity: number | null;
    readonly batchId: string | null;
    readonly expiresOn: string | null;
    readonly language: string;
    /** The questions the parse must leave open, as the rule names them. */
    readonly openQuestions: readonly string[];
  };
}

export type GoldenCase = GoldenExtractionCase | GoldenVoiceCase;

export interface GoldenSetRefusal {
  readonly file: string;
  readonly reason: string;
}

export interface GoldenSetLoad {
  readonly directory: string;
  readonly cases: readonly GoldenCase[];
  readonly refused: readonly GoldenSetRefusal[];
}

const toleranceSchema = z.strictObject({
  by: z.number().nonnegative(),
  reason: z.string().trim().min(1),
});

const extractionLineSchema = z.strictObject({
  itemId: z.string().trim().min(1),
  itemName: z.string().trim().min(1),
  quantity: z.int().nonnegative(),
  tolerance: toleranceSchema.optional(),
  batchId: z.string().trim().min(1).nullable(),
  expiresOn: dateSchema.nullable(),
  routing: z.enum(['write', 'review']),
});

const extractionExpectationSchema = z.strictObject({
  registerDate: dateSchema.nullable(),
  lines: z.array(extractionLineSchema).min(1),
});

const voiceExpectationSchema = z.strictObject({
  observedOn: dateSchema,
  intent: voiceIntentSchema,
  itemId: z.string().trim().min(1).nullable(),
  quantity: z.int().nonnegative().nullable(),
  batchId: z.string().trim().min(1).nullable(),
  expiresOn: dateSchema.nullable(),
  language: z.string().trim().min(2),
  openQuestions: z.array(z.enum(VOICE_PROBLEMS)),
});

const provenanceSchema = z.strictObject({
  command: z.string().trim().min(1),
  capturedOn: dateSchema,
  model: z.string().trim().min(1),
  mediaDigest: z
    .string()
    .trim()
    .regex(/^sha256:[0-9a-f]{64}$/, 'must be `sha256:` followed by the digest in lower-case hex'),
});

const caseFileSchema = z.strictObject({
  id: z.string().trim().min(1),
  task: z.string().trim().min(1),
  provenance: provenanceSchema,
  media: z.string().trim().min(1),
  recorded: z.unknown(),
  expected: z.unknown(),
});

/** Raised for a case file that cannot be scored, with the reason it cannot. */
export class GoldenCaseRefusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GoldenCaseRefusal';
  }
}

const issuesOf = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');

interface ScorableTask {
  readonly id: string;
  readonly prompt: Prompt<unknown>;
  readonly expectation: z.ZodType;
}

/**
 * The tasks this harness can score.
 *
 * Two, and both are intake: a photograph read and an utterance parsed. The
 * narrative tasks produce prose to be *read*, and their quality is not a
 * field-by-field comparison — the grounding evaluation is what holds them. A case
 * filed under any other task is refused by name rather than silently skipped,
 * because a corpus file that is quietly ignored is a corpus a reader believes is
 * being checked.
 */
const SCORABLE: readonly ScorableTask[] = [
  {
    id: stockExtractionPrompt.id,
    prompt: stockExtractionPrompt,
    expectation: extractionExpectationSchema,
  },
  {
    id: voiceCommandPrompt.id,
    prompt: voiceCommandPrompt,
    expectation: voiceExpectationSchema,
  },
];

const digestOf = (path: string): string =>
  `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

/** Refuse a case whose label cannot mean what it says. */
function checkLabel(
  catalogue: readonly Item[],
  expectation: z.infer<typeof extractionExpectationSchema>,
): void {
  for (const [index, line] of expectation.lines.entries()) {
    const labelled = catalogue.find((item) => item.id === line.itemId);
    if (labelled === undefined) {
      throw new GoldenCaseRefusal(
        `line ${String(index + 1)}: itemId "${line.itemId}" is not in the catalogue this platform stocks`,
      );
    }

    // The label is a catalogue identity, so a name that resolves to a *different*
    // entry is a label that contradicts itself and would score a correct reader
    // wrong. A name that resolves to nothing, or to several entries, is legitimate
    // — a smudged name is exactly what the review queue is for — so only an
    // unambiguous disagreement is refused.
    const match = resolveItem({ writtenName: line.itemName, catalogue });
    if (match.kind === 'matched' && match.item.id !== line.itemId) {
      throw new GoldenCaseRefusal(
        `line ${String(index + 1)}: the name "${line.itemName}" resolves to "${match.item.id}", not to the labelled "${line.itemId}"`,
      );
    }
  }
}

/** Parse one case file into a case, or explain why it is not one. */
function parseCase(text: string, directory: string, catalogue: readonly Item[]): GoldenCase {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new GoldenCaseRefusal(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = caseFileSchema.safeParse(raw);
  if (!parsed.success) {
    // A case without provenance lands here, which is the check that matters most:
    // the message names the missing field rather than the file being skipped.
    throw new GoldenCaseRefusal(`a case needs ${issuesOf(parsed.error)}`);
  }

  const file_ = parsed.data;
  const task = SCORABLE.find((candidate) => candidate.id === file_.task);
  if (task === undefined) {
    throw new GoldenCaseRefusal(
      `task "${file_.task}" is not one this harness scores; it scores ${SCORABLE.map((candidate) => candidate.id).join(', ')}`,
    );
  }

  const media = resolve(directory, file_.media);
  if (!existsSync(media)) {
    throw new GoldenCaseRefusal(
      `the media "${file_.media}" the recording belongs to is not in the corpus`,
    );
  }
  const digest = digestOf(media);
  if (digest !== file_.provenance.mediaDigest) {
    throw new GoldenCaseRefusal(
      `the digest of "${file_.media}" is ${digest}, not the recorded ${file_.provenance.mediaDigest} — this recording does not belong to this media`,
    );
  }

  const expectation = task.expectation.safeParse(file_.expected);
  if (!expectation.success) {
    throw new GoldenCaseRefusal(`the labels are malformed: ${issuesOf(expectation.error)}`);
  }

  const recorded = task.prompt.schema.safeParse(file_.recorded);
  if (!recorded.success) {
    throw new GoldenCaseRefusal(
      `the recorded response no longer satisfies ${file_.task}: ${issuesOf(recorded.error)}`,
    );
  }

  if (file_.task === stockExtractionPrompt.id) {
    const labels = extractionExpectationSchema.parse(file_.expected);
    checkLabel(catalogue, labels);

    return {
      kind: 'stock-extraction',
      id: file_.id,
      task: file_.task,
      provenance: file_.provenance,
      media,
      recorded: recorded.data as StockExtraction,
      expected: {
        registerDate: labels.registerDate,
        lines: labels.lines.map((line) => ({
          itemId: line.itemId,
          itemName: line.itemName,
          quantity: line.quantity,
          tolerance: line.tolerance ?? null,
          batchId: line.batchId,
          expiresOn: line.expiresOn,
          routing: line.routing,
        })),
      },
    };
  }

  const labels = voiceExpectationSchema.parse(file_.expected);
  if (labels.itemId !== null && !catalogue.some((item) => item.id === labels.itemId)) {
    throw new GoldenCaseRefusal(
      `the labelled itemId "${labels.itemId}" is not in the catalogue this platform stocks`,
    );
  }

  return {
    kind: 'voice-command',
    id: file_.id,
    task: file_.task,
    provenance: file_.provenance,
    media,
    recorded: recorded.data as VoiceCaptureCommand,
    expected: labels,
  };
}

/**
 * Read the corpus.
 *
 * Every file that cannot be scored is **reported**, not skipped. The distinction
 * matters at exactly the moment this harness is used to prove something: a corpus
 * with one unreadable case in it and one readable one has to say both things.
 */
export function loadGoldenSet(directory: string, catalogue: readonly Item[]): GoldenSetLoad {
  const absolute = resolve(directory);
  if (!existsSync(absolute)) {
    return {
      directory: absolute,
      cases: [],
      refused: [{ file: absolute, reason: 'the corpus directory does not exist' }],
    };
  }

  const files = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.case.json'))
    .map((entry) => entry.name)
    .sort();

  const cases: GoldenCase[] = [];
  const refused: GoldenSetRefusal[] = [];

  for (const file of files) {
    try {
      cases.push(parseCase(readFileSync(join(absolute, file), 'utf8'), absolute, catalogue));
    } catch (error) {
      refused.push({
        file,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { directory: absolute, cases, refused };
}

/**
 * The four states a run can end in.
 *
 * `corpus-unreadable` is separate from `not-measured` on purpose. An empty corpus
 * is an honest absence that a CI job may accept while a key is missing; a corpus
 * file that cannot be read is something a person has to fix, and folding the two
 * together would let a broken case file sit in a green log forever.
 */
export type GoldenVerdict =
  'measured-and-passing' | 'measured-and-below-threshold' | 'not-measured' | 'corpus-unreadable';

export interface GoldenFailure {
  readonly caseId: string;
  readonly where: string;
  readonly detail: string;
}

export interface GoldenCaseScore {
  readonly id: string;
  readonly kind: GoldenCase['kind'];
  readonly lines: number;
  readonly failures: readonly GoldenFailure[];
  /** Lines this reading would have written that a person should have decided. */
  readonly falseAccepts: number;
}

export interface GoldenSetReport {
  readonly directory: string;
  readonly refused: readonly GoldenSetRefusal[];
  readonly scores: readonly GoldenCaseScore[];
  readonly fields: Readonly<Record<GoldenDimension, GoldenFieldTally>>;
  readonly falseAccepts: number;
  /** `null` when nothing was comparable, which is not the same as zero. */
  readonly fieldAccuracy: number | null;
  readonly thresholds: { readonly fieldAccuracy: number; readonly falseAccepts: number };
  readonly verdict: GoldenVerdict;
  readonly notMeasuredReason: string | null;
  readonly failures: readonly GoldenFailure[];
}

class Tally {
  readonly counts = new Map<GoldenDimension, { correct: number; total: number }>();

  add(dimension: GoldenDimension, correct: boolean): void {
    const current = this.counts.get(dimension) ?? { correct: 0, total: 0 };
    this.counts.set(dimension, {
      correct: current.correct + (correct ? 1 : 0),
      total: current.total + 1,
    });
  }

  /** Compared only when there is something to compare: two absences are not a match. */
  compare(dimension: GoldenDimension, expected: unknown, recorded: unknown): void {
    if (expected === null && recorded === null) {
      return;
    }
    this.add(dimension, expected === recorded);
  }

  snapshot(): Record<GoldenDimension, GoldenFieldTally> {
    const entries = GOLDEN_DIMENSIONS.map(
      (dimension): readonly [GoldenDimension, GoldenFieldTally] => [
        dimension,
        this.counts.get(dimension) ?? { correct: 0, total: 0 },
      ],
    );
    return Object.fromEntries(entries) as Record<GoldenDimension, GoldenFieldTally>;
  }
}

interface LineOutcome {
  readonly failures: readonly GoldenFailure[];
  readonly falseAccepts: number;
}

function scoreExtractionCase(
  goldenCase: GoldenExtractionCase,
  catalogue: readonly Item[],
  tally: Tally,
): LineOutcome {
  const failures: GoldenFailure[] = [];
  let falseAccepts = 0;
  const fail = (where: string, detail: string): void => {
    failures.push({ caseId: goldenCase.id, where, detail });
  };

  tally.compare(
    'register-date',
    goldenCase.expected.registerDate,
    goldenCase.recorded.registerDate,
  );
  if (goldenCase.expected.registerDate !== goldenCase.recorded.registerDate) {
    fail(
      'register',
      `the register is dated ${goldenCase.expected.registerDate ?? 'nothing'}, read as ${goldenCase.recorded.registerDate ?? 'nothing'}`,
    );
  }

  const labelled = new Map(goldenCase.expected.lines.map((line) => [line.itemId, line]));
  const seen = new Set<string>();

  for (const [index, line] of goldenCase.recorded.lines.entries()) {
    const where = `line ${String(index + 1)}`;
    const match = resolveItem({ writtenName: line.itemName, catalogue });
    const resolved = match.kind === 'matched' ? match.item.id : null;
    const expected = resolved === null ? undefined : labelled.get(resolved);

    if (resolved === null || expected === undefined || seen.has(resolved)) {
      tally.add('item', false);
      fail(
        where,
        resolved === null
          ? `the reader wrote "${line.itemName}", which resolves to no catalogue entry`
          : `the reader wrote "${line.itemName}", resolving to "${resolved}", which is not a line of the labelled register`,
      );
      continue;
    }

    seen.add(resolved);
    tally.add('item', true);

    const tolerance = expected.tolerance?.by ?? 0;
    const withinTolerance = Math.abs(line.quantity - expected.quantity) <= tolerance;
    tally.add('quantity', withinTolerance);
    if (!withinTolerance) {
      fail(
        where,
        `quantity: ${expected.itemName} is labelled ${String(expected.quantity)}${
          expected.tolerance === null
            ? ''
            : ` ± ${String(expected.tolerance.by)} (${expected.tolerance.reason})`
        }, read as ${String(line.quantity)}`,
      );
    }

    tally.compare('batch', expected.batchId, line.batchId);
    if (expected.batchId !== line.batchId) {
      fail(
        where,
        `batch: labelled ${expected.batchId ?? 'none'}, read as ${line.batchId ?? 'none'}`,
      );
    }

    tally.compare('expiry', expected.expiresOn, line.expiresOn);
    if (expected.expiresOn !== line.expiresOn) {
      fail(
        where,
        `expiry: labelled ${expected.expiresOn ?? 'none'}, read as ${line.expiresOn ?? 'none'}`,
      );
    }

    const decision = decideLine({
      line,
      catalogue,
      occurredOn:
        goldenCase.expected.registerDate ?? goldenCase.recorded.registerDate ?? '2026-09-24',
    });
    const decided = decision.reasons.length === 0 ? 'write' : 'review';
    tally.add('routing', decided === expected.routing);
    if (decided !== expected.routing) {
      fail(
        where,
        `routing: the labelled register says ${expected.routing}, the platform would ${decided}${
          decision.reasons.length === 0 ? '' : ` (${decision.reasons.join(', ')})`
        }`,
      );
    }
    if (expected.routing === 'review' && decided === 'write') {
      falseAccepts += 1;
    }
  }

  // A labelled line the reader did not return is a miss on every field it should
  // have carried, not one missing row: it is the failure mode that leaves a shelf
  // invisible rather than wrong.
  for (const [itemId, line] of labelled) {
    if (seen.has(itemId)) {
      continue;
    }
    for (const dimension of ['item', 'quantity', 'batch', 'expiry', 'routing'] as const) {
      tally.add(dimension, false);
    }
    fail(
      'register',
      `the labelled register has a line the reader did not return: ${line.itemName} (${itemId}), ${String(line.quantity)} units`,
    );
  }

  return { failures, falseAccepts };
}

function scoreVoiceCase(
  goldenCase: GoldenVoiceCase,
  catalogue: readonly Item[],
  tally: Tally,
): LineOutcome {
  const failures: GoldenFailure[] = [];
  const expected = goldenCase.expected;
  const command = goldenCase.recorded;

  const record = (dimension: GoldenDimension, expectedValue: unknown, actual: unknown): void => {
    tally.compare(dimension, expectedValue, actual);
    if (expectedValue !== actual && !(expectedValue === null && actual === null)) {
      failures.push({
        caseId: goldenCase.id,
        where: dimension,
        detail: `labelled ${String(expectedValue)}, parsed as ${String(actual)}`,
      });
    }
  };

  record('intent', expected.intent, command.intent);
  record('language', expected.language, command.language);
  record('quantity', expected.quantity, command.quantity);
  record('batch', expected.batchId, command.batchId);
  record('expiry', expected.expiresOn, command.expiresOn);

  const decision = decideVoiceCommand({
    command,
    catalogue,
    observedOn: expected.observedOn,
  });
  const resolved = decision.item?.id ?? null;
  record('item', expected.itemId, resolved);

  const decided = [...decision.problems].sort();
  const labelled = [...expected.openQuestions].sort();
  tally.add('open-questions', decided.join(',') === labelled.join(','));
  if (decided.join(',') !== labelled.join(',')) {
    failures.push({
      caseId: goldenCase.id,
      where: 'open questions',
      detail: `labelled [${labelled.join(', ')}], the rule finds [${decided.join(', ')}]`,
    });
  }

  // A question the platform should have asked and did not is the same failure as a
  // line written too early: a person is not going to be asked about something the
  // platform believes it already knows.
  const missed = labelled.filter((problem) => !decided.some((found) => found === problem));

  return { failures, falseAccepts: missed.length };
}

/** Score a loaded corpus against the catalogue it will be resolved through. */
export function scoreGoldenSet(input: {
  readonly load: GoldenSetLoad;
  readonly catalogue: readonly Item[];
  readonly thresholds?: { readonly fieldAccuracy: number; readonly falseAccepts: number };
}): GoldenSetReport {
  const thresholds = input.thresholds ?? GOLDEN_THRESHOLDS;
  const tally = new Tally();
  const scores: GoldenCaseScore[] = [];

  for (const goldenCase of input.load.cases) {
    const outcome =
      goldenCase.kind === 'stock-extraction'
        ? scoreExtractionCase(goldenCase, input.catalogue, tally)
        : scoreVoiceCase(goldenCase, input.catalogue, tally);

    scores.push({
      id: goldenCase.id,
      kind: goldenCase.kind,
      lines: goldenCase.kind === 'stock-extraction' ? goldenCase.expected.lines.length : 1,
      failures: outcome.failures,
      falseAccepts: outcome.falseAccepts,
    });
  }

  const fields = tally.snapshot();
  const compared = GOLDEN_DIMENSIONS.reduce(
    (total, dimension) => ({
      correct: total.correct + fields[dimension].correct,
      total: total.total + fields[dimension].total,
    }),
    { correct: 0, total: 0 },
  );
  const falseAccepts = scores.reduce((total, score) => total + score.falseAccepts, 0);

  const measured =
    input.load.refused.length === 0 && input.load.cases.length > 0 && compared.total > 0;
  const fieldAccuracy = measured ? compared.correct / compared.total : null;

  const verdict: GoldenVerdict =
    input.load.refused.length > 0
      ? 'corpus-unreadable'
      : !measured
        ? 'not-measured'
        : fieldAccuracy !== null &&
            fieldAccuracy >= thresholds.fieldAccuracy &&
            falseAccepts <= thresholds.falseAccepts
          ? 'measured-and-passing'
          : 'measured-and-below-threshold';

  return {
    directory: input.load.directory,
    refused: input.load.refused,
    scores,
    fields,
    falseAccepts,
    fieldAccuracy,
    thresholds: { fieldAccuracy: thresholds.fieldAccuracy, falseAccepts: thresholds.falseAccepts },
    verdict,
    notMeasuredReason: verdict === 'not-measured' ? reasonNothingWasMeasured(input.load) : null,
    failures: scores.flatMap((score) => score.failures),
  };
}

function reasonNothingWasMeasured(load: GoldenSetLoad): string {
  if (load.cases.length === 0) {
    return [
      'the corpus is empty.',
      'A case is only a case if its response was captured from a real call, with the command',
      'and the date recorded, and no key is configured — so there is nothing here that was not',
      'written by hand, and a hand-written case would be the measurement pretending to exist.',
      'See the corpus README for the two commands that capture one.',
    ].join(' ');
  }
  return 'no case carried a field that could be compared.';
}

/** The states, as an exit code a CI job can act on. */
export function goldenSetExitCode(report: GoldenSetReport): 0 | 1 | 2 {
  switch (report.verdict) {
    case 'measured-and-passing':
      return GOLDEN_EXIT_CODES.passing;
    case 'not-measured':
      return GOLDEN_EXIT_CODES.notMeasured;
    default:
      return GOLDEN_EXIT_CODES.failing;
  }
}

const rate = (tally: GoldenFieldTally): string =>
  tally.total === 0
    ? 'not measured (nothing to compare)'
    : `${String(tally.correct)}/${String(tally.total)}`;

/** The run, as a person reads it. */
export function renderGoldenSetReport(report: GoldenSetReport): string {
  const lines: string[] = [
    '',
    'Extraction accuracy against the golden set',
    `  corpus             ${report.directory}`,
    `  cases              ${String(report.scores.length)}${
      report.refused.length === 0 ? '' : `, ${String(report.refused.length)} refused`
    }`,
    `  threshold          field accuracy ${report.thresholds.fieldAccuracy.toFixed(2)}, and no line written that a person should have decided (${String(report.thresholds.falseAccepts)} false accepts)`,
    '  scored against     the responses recorded in the corpus, so this measures the reader that',
    '                     produced them — a regression test, not a live measurement',
    '',
  ];

  for (const refusal of report.refused) {
    lines.push(`  REFUSED ${refusal.file}`, `       ${refusal.reason}`);
  }

  if (report.verdict === 'corpus-unreadable') {
    lines.push(
      'CORPUS UNREADABLE — a case file in the corpus cannot be scored, and a corpus that cannot',
      'be read is not a smaller corpus: the files above say what a person has to fix.',
      '',
      ...(report.scores.length === 0
        ? ['No other case could be scored, so this run measured nothing.']
        : [
            `The other ${String(report.scores.length)} case(s) still scored, and their figures follow.`,
            '',
          ]),
      '',
      `Exit code: ${String(GOLDEN_EXIT_CODES.failing)} — a corpus file has to be fixed.`,
      '',
    );
    return lines.join('\n');
  }

  if (report.verdict === 'not-measured') {
    lines.push(
      'NOT MEASURED — no percentage is reported, because a rate over an empty set is not a',
      'measurement and would make a green run mean nothing was checked.',
      '',
      `Reason: ${report.notMeasuredReason ?? 'nothing was comparable.'}`,
      '',
      'This is the honest state of the corpus, not a failure of the reader. It becomes a',
      'measurement the moment a real call is captured into the corpus and this command is run',
      'again; nothing else about the command changes when it does.',
      '',
      ...(report.failures.length === 0
        ? []
        : [
            'Failures worth reading even here (labels or files a person has to fix):',
            ...report.failures.map(
              (failure) => `  ${failure.caseId} ${failure.where}: ${failure.detail}`,
            ),
            '',
          ]),
      `Exit code: ${String(GOLDEN_EXIT_CODES.notMeasured)} — not measured.`,
      '',
    );
    return lines.join('\n');
  }

  lines.push(
    '  field accuracy     ',
    ...GOLDEN_DIMENSIONS.map(
      (dimension) => `    ${dimension.padEnd(15)}${rate(report.fields[dimension])}`,
    ),
    `  overall            ${report.fieldAccuracy === null ? 'not measured' : report.fieldAccuracy.toFixed(4)}`,
    `  false accepts      ${String(report.falseAccepts)} (must be ${String(report.thresholds.falseAccepts)})`,
    '',
  );

  if (report.failures.length === 0) {
    lines.push('Every labelled field matched the recorded reading.', '');
  } else {
    lines.push(
      `Failures (${String(report.failures.length)}):`,
      ...report.failures.map(
        (failure) => `  ${failure.caseId} ${failure.where}: ${failure.detail}`,
      ),
      '',
    );
  }

  lines.push(
    report.verdict === 'measured-and-passing'
      ? `PASS — measured and met the stated threshold over ${String(report.scores.length)} case(s).`
      : 'BELOW THRESHOLD — measured and did not meet the stated threshold; see the failures above.',

    '',
    `Exit code: ${String(goldenSetExitCode(report))}.`,
    '',
    'The population is the corpus above. A figure from one population does not transfer to',
    'another: report the cases it was measured on beside it, as this does.',
    '',
  );

  return lines.join('\n');
}
