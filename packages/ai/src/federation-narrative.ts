import { roundNarrativeSchema } from '@civora/domain';
import type {
  Fact,
  ReasoningProvider,
  ReasoningRequest,
  ReasoningResponse,
  RoundNarrative,
} from '@civora/domain';
import type { ZodType } from 'zod';

import { grounded } from './grounding';
import { federationNarrativePrompt } from './prompts/federation-narrative';

/**
 * Summarising a federated round, without letting the writer introduce a number.
 *
 * Every figure a narrative may mention travels as a fact: the round's own counts,
 * the participants' losses, the noise the accountant priced, the ε it spent and
 * the budget it was asked for. The grounding rule then refuses a draft whose
 * numerals appear in none of them, and the citation check refuses a citation
 * naming a fact the round does not carry — an explanation resting on a
 * measurement nobody took is the same failure with better manners.
 *
 * A refusal is a result. With no provider configured (no Gemini key) every round
 * refuses, and the Console shows the provider's own sentence per round rather
 * than an empty panel a reader could mistake for agreement.
 */

/** One round's ledger entry and the figures around it, as the writer is given them. */
export interface RoundNarrativeInput {
  readonly round: number;
  readonly rounds: number;
  readonly siloCount: number;
  readonly countryId: string;
  readonly regionLevelName: string;
  readonly model: string;
  readonly participants: readonly {
    readonly siloId: string;
    readonly label: string;
    readonly sampleCount: number;
    readonly localLoss: number;
    readonly updateNorm: number;
  }[];
  readonly meanLocalLoss: number;
  /** The shared model's error before this round: the previous entry, or the start. */
  readonly globalLossBefore: number;
  readonly globalLoss: number;
  /** Weighted spread of the updates, or null when masking hid them. */
  readonly divergence: number | null;
  readonly clippedSilos: number;
  readonly noiseStandardDeviation: number;
  readonly epsilonTarget: number | null;
  /** Cumulative ε after this round, or null when the run added no noise. */
  readonly epsilonSpent: number | null;
  readonly delta: number;
  readonly bytesIn: number;
  readonly masked: boolean;
}

/** The pieces of a narrative a person reads, and the field each came from. */
export function narrativeTextsOf(
  narrative: RoundNarrative,
): readonly (readonly [string, string])[] {
  return [
    ['headline', narrative.headline],
    ['summary', narrative.summary],
    ...narrative.limitations.map(
      (limitation, index) => [`limitations.${String(index)}`, limitation] as const,
    ),
  ];
}

/** A figure that may be absent, stated as absent rather than as a zero. */
const orAbsent = (key: string, value: number | null, absent: string): readonly Fact[] =>
  value === null ? [{ key, value: absent }] : [{ key, value }];

/**
 * Every quantity and every named thing the narrative may rest on.
 *
 * The participant rows are named per silo — `participant:SIM-ODI:samples` — so a
 * narrative that says one silo holds more rows than another is quoting the
 * ledger, and one that says something the ledger does not contain is refused.
 */
export function narrativeFactsOf(input: RoundNarrativeInput): readonly Fact[] {
  const samples = input.participants.reduce((total, entry) => total + entry.sampleCount, 0);
  return [
    { key: 'round', value: input.round },
    { key: 'rounds', value: input.rounds },
    { key: 'siloCount', value: input.siloCount },
    { key: 'participantCount', value: input.participants.length },
    { key: 'samples', value: samples },
    { key: 'meanLocalLoss', value: input.meanLocalLoss },
    { key: 'globalLossBefore', value: input.globalLossBefore },
    { key: 'globalLoss', value: input.globalLoss },
    ...orAbsent('divergence', input.divergence, 'not computable while the updates are masked'),
    { key: 'clippedSilos', value: input.clippedSilos },
    { key: 'noiseStandardDeviation', value: input.noiseStandardDeviation },
    ...orAbsent(
      'epsilonSpent',
      input.epsilonSpent,
      'no mechanism was run, so this round has no privacy bound',
    ),
    ...orAbsent('epsilonTarget', input.epsilonTarget, 'no target was set'),
    { key: 'delta', value: input.delta },
    { key: 'bytesIn', value: input.bytesIn },
    { key: 'masked', value: input.masked ? 'yes' : 'no' },
    { key: 'countryId', value: input.countryId },
    { key: 'regionLevelName', value: input.regionLevelName },
    { key: 'model', value: input.model },
    ...input.participants.flatMap((entry): readonly Fact[] => [
      { key: `participant:${entry.siloId}:label`, value: entry.label },
      { key: `participant:${entry.siloId}:samples`, value: entry.sampleCount },
      { key: `participant:${entry.siloId}:localLoss`, value: entry.localLoss },
      { key: `participant:${entry.siloId}:updateNorm`, value: entry.updateNorm },
    ]),
  ];
}

/** The narrative schema, with the grounding and citation rules built in. */
export function narrativeSchemaFor(facts: readonly Fact[]): ZodType<RoundNarrative> {
  const names = new Set(facts.map((fact) => fact.key));

  return grounded(roundNarrativeSchema, facts, narrativeTextsOf).superRefine(
    (narrative, context) => {
      for (const citation of narrative.citations) {
        if (!names.has(citation)) {
          context.addIssue({
            code: 'custom',
            message: `the citation "${citation}" names no fact this round carries`,
            path: ['citations'],
          });
        }
      }
    },
  );
}

/**
 * The request for one round's narrative.
 *
 * The round number, the country and the level's name travel as task parameters
 * rather than as facts, so none of them can be cited as the source of a quantity.
 */
export function narrativeRequestFor(input: RoundNarrativeInput): ReasoningRequest<RoundNarrative> {
  const facts = narrativeFactsOf(input);
  const request = federationNarrativePrompt.request({
    facts,
    context: [
      { key: 'round', value: input.round },
      { key: 'countryId', value: input.countryId },
      { key: 'regionLevelName', value: input.regionLevelName },
    ],
  });

  return { ...request, schema: narrativeSchemaFor(facts) };
}

/** Write one round's narrative through whichever provider is configured. */
export async function writeRoundNarrative(
  provider: ReasoningProvider,
  input: RoundNarrativeInput,
): Promise<ReasoningResponse<RoundNarrative>> {
  return await provider.reason(narrativeRequestFor(input));
}

export interface NarrativeAttempt {
  readonly round: number;
  readonly status: 'written' | 'refused';
  readonly narrative: RoundNarrative | null;
  /** The provider's own sentence when it refused. Null when one was written. */
  readonly refusal: string | null;
  readonly provider: string;
  readonly model: string | null;
  readonly cacheHit: boolean;
}

/** Write one round's narrative, and report the refusal rather than throwing it. */
export async function generateRoundNarrative(
  provider: ReasoningProvider,
  input: RoundNarrativeInput,
): Promise<NarrativeAttempt> {
  try {
    const response = await writeRoundNarrative(provider, input);
    return {
      round: input.round,
      status: 'written',
      narrative: response.value,
      refusal: null,
      provider: response.provider,
      model: response.model,
      cacheHit: response.cacheHit,
    };
  } catch (error) {
    return {
      round: input.round,
      status: 'refused',
      narrative: null,
      refusal: error instanceof Error ? error.message : String(error),
      provider: provider.kind,
      model: null,
      cacheHit: false,
    };
  }
}

/** Write a narrative for each round, one attempt per round, in order. */
export async function generateRoundNarratives(
  provider: ReasoningProvider,
  inputs: readonly RoundNarrativeInput[],
): Promise<readonly NarrativeAttempt[]> {
  const attempts: NarrativeAttempt[] = [];
  for (const input of inputs) {
    attempts.push(await generateRoundNarrative(provider, input));
  }
  return attempts;
}
