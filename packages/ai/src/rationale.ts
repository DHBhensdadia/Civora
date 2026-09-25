import { transferRationaleSchema } from '@civora/domain';
import type {
  Fact,
  ReasoningProvider,
  ReasoningRequest,
  ReasoningResponse,
  TransferRationale,
} from '@civora/domain';
import type { ZodType } from 'zod';

import { grounded } from './grounding';
import { transferRationalePrompt } from './prompts/transfer-rationale';

/**
 * Explaining a transfer the optimiser proposed, without letting the explanation
 * introduce a number.
 *
 * The proposal is already decided: its quantity, its two facilities and the
 * figures the workbench shows beside it came from the solver, the validator and
 * the impact estimator. What the writer adds is the part a receiving pharmacist
 * needs in order to disagree — the summary in checkable terms, and the
 * conditions under which this transfer would be the wrong thing to do.
 *
 * Everything the writer may mention travels as a fact: the proposal's own
 * quantities, the transport figures, the impact the estimator measured, and the
 * assumption sentences the estimator printed beside them. A numeral that appears
 * in none of those is refused before anybody reads it, and a citation naming a
 * fact the proposal does not carry is refused the same way — an explanation that
 * rests on a measurement nobody took is the same failure with better manners.
 *
 * A refusal is a result. With no provider configured every attempt refuses, and
 * the workbench shows the provider's own sentence per proposal rather than an
 * empty space a reader could mistake for agreement.
 */

/** The proposal and the figures the workbench shows, as the writer is given them. */
export interface TransferRationaleInput {
  readonly proposalId: string;
  readonly donorFacility: string;
  readonly donorDistrict: string;
  readonly receiverFacility: string;
  readonly receiverDistrict: string;
  readonly item: string;
  readonly unit: string;
  readonly quantity: number;
  readonly batchId: string | null;
  readonly expiresOn: string | null;
  readonly distanceKm: number;
  readonly leadTimeDays: number;
  readonly shelfLifeOnArrivalDays: number;
  readonly coldChain: boolean;
  readonly assessment: string;
  /** Null where no forecast covered the pair, so no figure was measured. */
  readonly unmetDemandAvoided: number | null;
  readonly stockOutDaysAverted: number | null;
  readonly transportCost: number | null;
  readonly netBenefit: number | null;
  readonly donorDaysOfStockAfter: number;
  readonly receiverDaysOfStockAfter: number;
  /** The assumption sentences the estimator printed beside the impact. */
  readonly assumptions: readonly string[];
  /** The language to write in. The interface renders in English today. */
  readonly language?: string | undefined;
}

/** The pieces of a rationale a person reads, and the field each came from. */
export function rationaleTextsOf(
  rationale: TransferRationale,
): readonly (readonly [string, string])[] {
  return [
    ['summary', rationale.summary],
    ...rationale.conditions.map(
      (condition, index) => [`conditions.${String(index)}`, condition] as const,
    ),
  ];
}

/**
 * A measured impact figure, present only where one was measured.
 *
 * An unmeasured transfer is reported as unmeasured rather than as a zero: a fact
 * of `0` would let a writer state that the transfer avoids nothing, which is a
 * claim the estimator never made.
 */
const impactFact = (key: string, value: number | null): readonly Fact[] =>
  value === null ? [] : [{ key, value }];

/**
 * Every quantity and every named reason the rationale may rest on.
 *
 * The quantities keep the solver's own units and precision — no rounding here,
 * because a rounded figure is a figure the record does not contain and the
 * grounding rule refuses it on exactly that ground.
 */
export function rationaleFactsOf(input: TransferRationaleInput): readonly Fact[] {
  return [
    { key: 'proposalId', value: input.proposalId },
    { key: 'donorFacility', value: input.donorFacility },
    { key: 'donorDistrict', value: input.donorDistrict },
    { key: 'receiverFacility', value: input.receiverFacility },
    { key: 'receiverDistrict', value: input.receiverDistrict },
    { key: 'item', value: input.item },
    { key: 'unit', value: input.unit },
    { key: 'quantity', value: input.quantity },
    { key: 'batchId', value: input.batchId ?? 'not chosen' },
    { key: 'expiresOn', value: input.expiresOn ?? 'unknown' },
    { key: 'distanceKm', value: input.distanceKm },
    { key: 'leadTimeDays', value: input.leadTimeDays },
    { key: 'shelfLifeOnArrivalDays', value: input.shelfLifeOnArrivalDays },
    { key: 'coldChain', value: input.coldChain ? 'yes' : 'no' },
    { key: 'assessment', value: input.assessment },
    ...impactFact('unmetDemandAvoided', input.unmetDemandAvoided),
    ...impactFact('stockOutDaysAverted', input.stockOutDaysAverted),
    ...impactFact('transportCost', input.transportCost),
    ...impactFact('netBenefit', input.netBenefit),
    { key: 'donorDaysOfStockAfter', value: input.donorDaysOfStockAfter },
    { key: 'receiverDaysOfStockAfter', value: input.receiverDaysOfStockAfter },
    ...input.assumptions.map((assumption, index): Fact => ({
      key: `assumption:${String(index)}`,
      value: assumption,
    })),
  ];
}

/** The rationale schema, with the grounding and citation rules built in. */
export function rationaleSchemaFor(facts: readonly Fact[]): ZodType<TransferRationale> {
  const names = new Set(facts.map((fact) => fact.key));

  return grounded(transferRationaleSchema, facts, rationaleTextsOf).superRefine(
    (rationale, context) => {
      for (const citation of rationale.citations) {
        if (!names.has(citation)) {
          context.addIssue({
            code: 'custom',
            message: `the citation "${citation}" names no fact this proposal carries`,
            path: ['citations'],
          });
        }
      }
    },
  );
}

/**
 * The request for one rationale.
 *
 * The proposal's identifier and the language travel as task parameters rather
 * than as facts, so neither can be cited as the source of a quantity.
 */
export function rationaleRequestFor(
  input: TransferRationaleInput,
): ReasoningRequest<TransferRationale> {
  const facts = rationaleFactsOf(input);
  const request = transferRationalePrompt.request({
    facts,
    context: [
      { key: 'proposalId', value: input.proposalId },
      { key: 'language', value: input.language ?? 'en' },
    ],
  });

  return { ...request, schema: rationaleSchemaFor(facts) };
}

/** Write one rationale through whichever provider is configured. */
export async function writeRationale(
  provider: ReasoningProvider,
  input: TransferRationaleInput,
): Promise<ReasoningResponse<TransferRationale>> {
  return await provider.reason(rationaleRequestFor(input));
}

/**
 * What one attempt at one rationale produced.
 *
 * A refusal is a result, not an absence. The workbench has to be able to say
 * "no rationale was written for this proposal, and here is why" — a blank space
 * where an explanation should be is the shape that lets a page look like it is
 * working while nothing is behind it.
 */
export interface RationaleAttempt {
  readonly proposalId: string;
  readonly status: 'written' | 'refused';
  readonly rationale: TransferRationale | null;
  /** The provider's own sentence when it refused. Null when one was written. */
  readonly refusal: string | null;
  readonly provider: string;
  readonly model: string | null;
  readonly cacheHit: boolean;
}

/** Write one rationale, and report the refusal rather than throwing it. */
export async function generateRationale(
  provider: ReasoningProvider,
  input: TransferRationaleInput,
): Promise<RationaleAttempt> {
  try {
    const response = await writeRationale(provider, input);
    return {
      proposalId: input.proposalId,
      status: 'written',
      rationale: response.value,
      refusal: null,
      provider: response.provider,
      model: response.model,
      cacheHit: response.cacheHit,
    };
  } catch (error) {
    return {
      proposalId: input.proposalId,
      status: 'refused',
      rationale: null,
      refusal: error instanceof Error ? error.message : String(error),
      provider: provider.kind,
      model: null,
      cacheHit: false,
    };
  }
}

/**
 * Write every rationale for a set of proposals, one attempt per proposal.
 *
 * Sequential on purpose, for the same reason the advisory batch is: a set of
 * requests fired at once turns a rate limit into a wave of refusals that all say
 * the same thing, and the honest outcome is a complete account of what was
 * attempted.
 */
export async function generateRationales(
  provider: ReasoningProvider,
  inputs: readonly TransferRationaleInput[],
): Promise<readonly RationaleAttempt[]> {
  const attempts: RationaleAttempt[] = [];

  for (const input of inputs) {
    attempts.push(await generateRationale(provider, input));
  }

  return attempts;
}
