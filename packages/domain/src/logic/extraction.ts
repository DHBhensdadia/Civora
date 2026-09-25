import type { Item } from '../model/catalogue';
import type { DateOnly, FacilityId, Instant, ItemId } from '../model/common';
import { EXTRACTION_REVIEW_THRESHOLD } from '../model/extraction';
import type { StockExtraction, StockExtractionLine } from '../model/extraction';
import { ingestRequestSchema } from '../model/ingest';
import type { IngestRequest } from '../model/ingest';
import { completeSubmission, PLATFORM_STAMP } from './ingest';
import type { IngestStamp } from './ingest';
import { matchItemByName } from './match';

/**
 * What happens to a photograph between the model reading it and the ledger
 * recording it.
 *
 * This is the platform's half of vision intake, and it is deliberately the
 * larger half. A model reads the page; everything after that is a rule that can
 * be read, tested and disagreed with:
 *
 *  - **A line reaches the ledger only if it is complete enough to be a
 *    movement.** Confidence alone is not enough. A paper register that states a
 *    batch and an expiry is a goods-received register, and those two fields are
 *    exactly what the ledger demands of stock arriving at a facility. A line
 *    that states a quantity and nothing else is a physical count: turning it
 *    into a receipt would invent a delivery, and turning it into an adjustment
 *    would invent a direction. It goes to review.
 *  - **A name becomes an identity only when the catalogue says so.** The
 *    matching is deterministic (`matchItemByName`), and a name that matches two
 *    entries or none produces a question rather than a guess.
 *  - **A rejection carries its reasons.** Every line in the review queue says
 *    what a person has to decide, in the order the reasons were found, and an
 *    ambiguous name brings its candidates with it.
 *
 * Nothing here is a model call, and nothing here can be talked out of a
 * rejection by a confident answer.
 */

/** Why a line cannot be written to the ledger without a person looking at it. */
export const REVIEW_REASONS = [
  'low-confidence',
  'item-unmatched',
  'item-ambiguous',
  'batch-not-read',
  'expiry-not-read',
  'expiry-not-after-register',
] as const;

export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** A line that can be written, with the identity and the day it is written as. */
export interface AcceptedIntakeLine {
  /** Position in the extraction, so a decision can name the line it is about. */
  readonly index: number;
  readonly line: StockExtractionLine;
  /** The catalogue entry the written name resolved to, unambiguously. */
  readonly item: Item;
  /** The day the movement is recorded as happening. */
  readonly occurredOn: DateOnly;
}

/** A line a person has to decide about. */
export interface ReviewedIntakeLine {
  readonly index: number;
  readonly line: StockExtractionLine;
  readonly reasons: readonly ReviewReason[];
  /** The catalogue entries the name could have meant, when it was ambiguous. */
  readonly candidates: readonly Item[];
}

export interface ExtractionPartition {
  readonly accepted: readonly AcceptedIntakeLine[];
  readonly review: readonly ReviewedIntakeLine[];
}

export interface LineDecisionInput {
  readonly line: StockExtractionLine;
  readonly catalogue: readonly Item[];
  /**
   * The day the movement belongs to.
   *
   * The register's own date when the page states one — a batch that arrived on
   * Tuesday is recorded against Tuesday however long the photograph took to
   * reach the platform — and the day it was captured when the page states none.
   */
  readonly occurredOn: DateOnly;
  /** Overridable so that a comparison can be made at two thresholds. */
  readonly threshold?: number;
  /**
   * An identity a person chose while reviewing the line.
   *
   * Set only by the review queue, and it is not a guess being smuggled back in:
   * a person looking at the page and at the catalogue is the authority for what
   * the line means, which is precisely why the queue exists. The rest of the
   * rules below still apply to the line afterwards.
   */
  readonly chosenItemId?: string | undefined;
}

/** What one line's fate is, and why. */
export interface LineDecision {
  /** Empty means the line can be written. */
  readonly reasons: readonly ReviewReason[];
  /** The identity the line resolved to, or null when it resolved to none. */
  readonly item: Item | null;
  /** The entries the name could have meant, when it was ambiguous. */
  readonly candidates: readonly Item[];
}

/**
 * Decide one line: can it be written, and if not, why not.
 *
 * One function rather than two, because the review queue and the intake path
 * have to agree about what "acceptable" means: a queue that accepted a line the
 * ledger's own rules reject would be a queue that lies. All reasons are
 * collected rather than the first, because a person fixing a line wants to know
 * everything that is wrong with it.
 */
export function decideLine(input: LineDecisionInput): LineDecision {
  const threshold = input.threshold ?? EXTRACTION_REVIEW_THRESHOLD;
  const reasons: ReviewReason[] = [];

  if (input.line.confidence < threshold) {
    reasons.push('low-confidence');
  }

  let item: Item | null = null;
  let candidates: readonly Item[] = [];

  const chosen =
    input.chosenItemId === undefined
      ? undefined
      : input.catalogue.find((candidate) => candidate.id === input.chosenItemId);

  if (chosen !== undefined) {
    item = chosen;
  } else {
    const match = matchItemByName(input.line.itemName, input.catalogue);
    if (match.kind === 'matched') {
      item = match.item;
    } else if (match.kind === 'ambiguous') {
      reasons.push('item-ambiguous');
      candidates = match.candidates;
    } else {
      reasons.push('item-unmatched');
    }
  }

  if (input.line.batchId === null) {
    reasons.push('batch-not-read');
  }
  if (input.line.expiresOn === null) {
    reasons.push('expiry-not-read');
  } else if (input.line.expiresOn <= input.occurredOn) {
    // The ledger requires a batch's expiry to be after the day it moved, which
    // is right for a delivery and gets in the way of a register that recorded an
    // expired batch. Somebody has to say which day that belongs to.
    reasons.push('expiry-not-after-register');
  }

  return { reasons, item, candidates };
}

export interface ExtractionIntakeInput {
  readonly extraction: StockExtraction;
  readonly catalogue: readonly Item[];
  readonly occurredOn: DateOnly;
  readonly threshold?: number;
}

/** Route every line of an extraction to the ledger, or to review. */
export function partitionExtraction(input: ExtractionIntakeInput): ExtractionPartition {
  const accepted: AcceptedIntakeLine[] = [];
  const review: ReviewedIntakeLine[] = [];

  for (const [index, line] of input.extraction.lines.entries()) {
    const decision = decideLine({
      line,
      catalogue: input.catalogue,
      occurredOn: input.occurredOn,
      ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
    });

    if (decision.reasons.length === 0 && decision.item !== null) {
      accepted.push({ index, line, item: decision.item, occurredOn: input.occurredOn });
    } else {
      review.push({ index, line, reasons: decision.reasons, candidates: decision.candidates });
    }
  }

  return { accepted, review };
}

export interface VisionEntryInput {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly line: StockExtractionLine;
  readonly occurredOn: DateOnly;
  readonly capturedAt: Instant;
  readonly entryId: string;
  readonly idempotencyKey: string;
}

/**
 * The submission one accepted line becomes.
 *
 * `captureSource: 'vision'` is the field that makes the whole flow auditable: a
 * reader of the ledger can tell a photographed entry from a typed one, and the
 * interface is required to show the difference (the provenance badge). The kind
 * is `receipt` because a line that got this far names its batch and its expiry —
 * the shape of stock arriving, not of a balance.
 */
function suppliedBody(input: VisionEntryInput): {
  readonly type: 'stock_ledger_entry';
  readonly idempotencyKey: string;
  readonly captureSource: 'vision';
  readonly capturedAt: Instant;
  readonly observation: Record<string, unknown>;
} {
  return {
    type: 'stock_ledger_entry',
    idempotencyKey: input.idempotencyKey,
    captureSource: 'vision',
    capturedAt: input.capturedAt,
    observation: {
      id: input.entryId,
      facilityId: input.facilityId,
      itemId: input.itemId,
      kind: 'receipt',
      quantity: input.line.quantity,
      adjustmentDirection: null,
      occurredOn: input.occurredOn,
      batchId: input.line.batchId,
      expiresOn: input.line.expiresOn,
      correctsEntryId: null,
      counterpartFacilityId: null,
      transferId: null,
    },
  };
}

/**
 * The submission, completed and validated against the Phase 3 ingest contract.
 *
 * Completed here rather than at the boundary so that a line the partition
 * accepted cannot fail validation later and disappear between the two: if the
 * platform's own stamp makes this submission invalid, that is a bug in this
 * function, found by the test that submits an accepted line through the real
 * contract.
 */
export function visionIngestRequestFor(
  input: VisionEntryInput,
  stamp: IngestStamp = PLATFORM_STAMP,
): IngestRequest {
  return ingestRequestSchema.parse(completeSubmission(suppliedBody(input), stamp));
}
