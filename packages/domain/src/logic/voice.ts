import type { Item } from '../model/catalogue';
import type { DateOnly, FacilityId, Instant, ItemId } from '../model/common';
import { VOICE_STOCK_KINDS } from '../model/extraction';
import type { VoiceCaptureCommand } from '../model/extraction';
import { ingestRequestSchema } from '../model/ingest';
import type { IngestRequest } from '../model/ingest';
import { completeSubmission, PLATFORM_STAMP } from './ingest';
import type { IngestStamp } from './ingest';
import { resolveItem } from './match';

/**
 * What a spoken update becomes — and what has to be settled first.
 *
 * The people who record stock are comfortable speaking and less comfortable
 * typing, in a country with twenty-two scheduled languages. That is the whole
 * argument for voice intake, and it is also the reason the flow has a
 * confirmation step that nothing else has: speech is transcribed by a model, the
 * model's reading is a proposal, and the platform writes nothing until the person
 * who spoke has seen what was heard.
 *
 * This file is the part that is not the model: given a parsed command, it says
 * (a) which kind of record it would become, (b) the item it resolved to or the
 * entries it could have meant, and (c) everything a person still has to answer.
 * The confirmation screen renders exactly that list, which is why the list is
 * built here rather than in a component: the platform's rule and the question a
 * person is asked are the same thing, and a second implementation would let them
 * drift.
 *
 * A note on numbers, because it is the same rule as the photograph path and not
 * the same rule as the advisory path: the quantities here are **transcribed**,
 * not composed. The speaker said them. What keeps them honest is that nothing is
 * written before a person confirms the reading.
 */

/**
 * Everything that can be outstanding before a spoken update can be written.
 *
 * Deliberately short, and short for a reason worth stating: an intent, a name, a
 * quantity, a direction, a cadre and the bed counts are all *required by the
 * command schema*, so a parse that lost one of them never reaches this rule — the
 * adapter rejects it and re-asks the model with the complaint, which is the right
 * order. Asking a person to supply a quantity nobody spoke would be inviting them
 * to fill in a gap in the evidence.
 *
 * What is left is exactly what a transcript can legitimately omit while still
 * being about a real movement: which catalogue entry a name means, the batch and
 * expiry of arriving stock, and the number present out of the posts that are
 * filled.
 */
export const VOICE_PROBLEMS = [
  'intent-not-understood',
  'item-unmatched',
  'item-ambiguous',
  'batch-not-heard',
  'expiry-not-heard',
  'expiry-not-after-observation',
  'present-not-heard',
] as const;

export type VoiceProblem = (typeof VOICE_PROBLEMS)[number];

/** The observation types a spoken update can become. */
export const VOICE_OBSERVATION_TYPES = [
  'stock_ledger_entry',
  'bed_status',
  'staff_attendance',
] as const;
export type VoiceObservationType = (typeof VOICE_OBSERVATION_TYPES)[number];

export interface VoiceDecision {
  /** Empty means the update can be written — once a person has confirmed it. */
  readonly problems: readonly VoiceProblem[];
  readonly item: Item | null;
  readonly candidates: readonly Item[];
  /** The record this command would become, or null when it would become none. */
  readonly observation: VoiceObservationType | null;
}

export interface VoiceDecisionInput {
  readonly command: VoiceCaptureCommand;
  readonly catalogue: readonly Item[];
  /** The day the update is about, which the ledger's own rules are applied against. */
  readonly observedOn: DateOnly;
  /** An identity a person chose while confirming, taking precedence over the name. */
  readonly chosenItemId?: string | undefined;
}

export function decideVoiceCommand(input: VoiceDecisionInput): VoiceDecision {
  const { command } = input;
  const problems: VoiceProblem[] = [];
  let item: Item | null = null;
  let candidates: readonly Item[] = [];
  let observation: VoiceObservationType | null = null;

  switch (command.intent) {
    case 'unknown':
      problems.push('intent-not-understood');
      break;

    case 'stock_receipt':
    case 'stock_issue':
    case 'stock_adjustment': {
      observation = 'stock_ledger_entry';

      const match = resolveItem({
        writtenName: command.itemName ?? '',
        catalogue: input.catalogue,
        ...(input.chosenItemId === undefined ? {} : { chosenItemId: input.chosenItemId }),
      });
      if (match.kind === 'matched') {
        item = match.item;
      } else if (match.kind === 'ambiguous') {
        problems.push('item-ambiguous');
        candidates = match.candidates;
      } else {
        problems.push('item-unmatched');
      }

      if (command.intent === 'stock_receipt') {
        // A receipt names the lot it arrived in; the ledger will not accept
        // arriving stock without one, and inventing a batch number is not an
        // option the platform has.
        if (command.batchId === null) {
          problems.push('batch-not-heard');
        }
        if (command.expiresOn === null) {
          problems.push('expiry-not-heard');
        } else if (command.expiresOn <= input.observedOn) {
          problems.push('expiry-not-after-observation');
        }
      }
      break;
    }

    case 'bed_status':
      observation = 'bed_status';
      break;

    case 'staff_attendance':
      observation = 'staff_attendance';
      // The cadre and the sanctioned/filled counts are required by the schema;
      // how many of the filled posts actually turned up is not, so it is the one
      // question this path asks.
      if (command.presentToday === null) {
        problems.push('present-not-heard');
      }
      break;
  }

  return { problems, item, candidates, observation };
}

export interface VoiceEntryInput {
  readonly facilityId: FacilityId;
  readonly command: VoiceCaptureCommand;
  /** The identity the command resolved to; required for a stock update. */
  readonly itemId: ItemId | null;
  /** The day the record is about. */
  readonly observedOn: DateOnly;
  readonly capturedAt: Instant;
  /** Allocated by the caller so that this function stays pure. */
  readonly recordId: string;
  readonly idempotencyKey: string;
}

/**
 * The submission a confirmed command becomes.
 *
 * `captureSource: 'voice'` is the field that makes the flow auditable: a reader
 * of the ledger can tell a spoken entry from a typed or a photographed one, and
 * the interface is required to show the difference.
 */
function suppliedBody(input: VoiceEntryInput): Record<string, unknown> {
  const { command, facilityId } = input;
  const envelope = {
    idempotencyKey: input.idempotencyKey,
    captureSource: 'voice' as const,
    capturedAt: input.capturedAt,
  };

  switch (command.intent) {
    case 'stock_receipt':
    case 'stock_issue':
    case 'stock_adjustment': {
      const kind = VOICE_STOCK_KINDS[command.intent];
      if (kind === undefined) {
        throw new Error(`a spoken stock update cannot become a ${command.intent} record`);
      }
      return {
        ...envelope,
        type: 'stock_ledger_entry',
        observation: {
          id: input.recordId,
          facilityId,
          itemId: input.itemId,
          kind,
          quantity: command.quantity,
          adjustmentDirection:
            command.intent === 'stock_adjustment' ? command.adjustmentDirection : null,
          occurredOn: input.observedOn,
          batchId: command.intent === 'stock_receipt' ? command.batchId : null,
          expiresOn: command.intent === 'stock_receipt' ? command.expiresOn : null,
          correctsEntryId: null,
          counterpartFacilityId: null,
          transferId: null,
        },
      };
    }

    case 'bed_status':
      return {
        ...envelope,
        type: 'bed_status',
        observation: {
          facilityId,
          observedOn: input.observedOn,
          bedsTotal: command.bedsTotal,
          bedsOccupied: command.bedsOccupied,
        },
      };

    case 'staff_attendance':
      return {
        ...envelope,
        type: 'staff_attendance',
        observation: {
          facilityId,
          observedOn: input.observedOn,
          cadre: command.cadre,
          postsSanctioned: command.postsSanctioned,
          postsFilled: command.postsFilled,
          presentToday: command.presentToday,
        },
      };

    case 'unknown':
      throw new Error('an utterance that was not understood cannot become a record');
  }
}

/**
 * The submission, completed and validated against the Phase 3 ingest contract.
 *
 * Parsed rather than assembled, for the same reason the vision path parses: if
 * the platform's own stamp makes a confirmed spoken update invalid, that is a bug
 * here, found by the test that submits one through the real contract — rather than
 * a record that disappears between a person's confirmation and the store.
 */
export function voiceIngestRequestFor(
  input: VoiceEntryInput,
  stamp: IngestStamp = PLATFORM_STAMP,
): IngestRequest {
  return ingestRequestSchema.parse(completeSubmission(suppliedBody(input), stamp));
}
