import {
  EXTRACTION_REVIEW_THRESHOLD,
  decideLine,
  partitionExtraction,
  visionIngestRequestFor,
} from '@civora/domain';
import type {
  BatchId,
  DateOnly,
  FacilityId,
  IngestReceipt,
  ItemId,
  ReviewReason,
  StockExtraction,
  StockExtractionLine,
} from '@civora/domain';

import { applySubmission } from './ingest-boundary';
import { getLiveStore } from './live-store';
import type { LiveStore } from './live-store';
import { canSubmitForFacility, scopeRefusalFor } from './session';
import type { Session } from './session';

/**
 * Vision intake: the reading, the decision about it, and the queue between the
 * two.
 *
 * A model reads a photograph; this file holds what it read and decides what may
 * be written from it. Three properties are the point of it:
 *
 *  - **A line the platform cannot stand behind goes to a person, and nowhere
 *    else.** Above the threshold and complete enough to be a movement, a line
 *    enters the ledger at intake; below it, or missing a batch, or naming an item
 *    the catalogue cannot resolve, it waits. The phase's rule is explicit that
 *    the queue exists so that a low-confidence reading never reaches the ledger
 *    unreviewed.
 *  - **A person's choice is an input, not a guess being smuggled back in.** When
 *    a name could have meant two items the queue offers both, and the chosen
 *    identity goes back through the same `decideLine` rule — the person is the
 *    authority for what the page says, and the other rules still apply.
 *  - **The record says which lines a person corrected**, because a ledger entry a
 *    human fixed and one the threshold accepted are different claims, and a
 *    reviewer reading the ledger months later is entitled to tell them apart.
 *
 * Like the projection and the alert inbox, the queue lives in the process. That
 * is a limitation of this build, stated rather than hidden: a deployment stores
 * it, and nothing above this file would change.
 */

/** Where a reading came from. */
export const READING_SOURCES = ['model', 'supplied'] as const;
export type ReadingSource = (typeof READING_SOURCES)[number];

/** What has been decided about one line. */
export const LINE_DECISIONS = ['pending', 'accepted', 'discarded'] as const;
export type LineDecision = (typeof LINE_DECISIONS)[number];

/** One catalogue entry offered to a person resolving an ambiguous name. */
export interface CandidateItem {
  readonly id: string;
  readonly name: string;
  /** Required in the label: the same medicine at two strengths is two entries. */
  readonly strength: string;
  readonly form: string;
}

export interface VisionLine {
  readonly index: number;
  /** The line as it stands, after any correction a person made. */
  readonly line: StockExtractionLine;
  /** The line as it was read, kept so a correction is visible rather than silent. */
  readonly extracted: StockExtractionLine;
  readonly itemId: string | null;
  readonly itemName: string | null;
  readonly candidates: readonly CandidateItem[];
  readonly reasons: readonly ReviewReason[];
  readonly decision: LineDecision;
  /** Who decided. `null` means the threshold accepted it, with no person involved. */
  readonly decidedBy: string | null;
  readonly receipt: IngestReceipt | null;
}

export interface VisionBatch {
  readonly id: string;
  readonly facilityId: FacilityId;
  readonly facilityName: string;
  /** The day the movement belongs to: the register's date, or the capture day. */
  readonly occurredOn: DateOnly;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly source: ReadingSource;
  /** The model that read it, or `none` when the reading was supplied. */
  readonly model: string;
  readonly cacheHit: boolean;
  readonly registerDate: string | null;
  /** What the reader said about the page: a cut-off edge, an unreadable column. */
  readonly pageNotes: readonly string[];
  readonly lines: readonly VisionLine[];
}

/** A refusal the interface can show, with the status the route answers with. */
export class VisionRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'VisionRefused';
    this.status = status;
  }
}

/** The threshold this process applies, exposed so a surface can state it. */
export const REVIEW_THRESHOLD = EXTRACTION_REVIEW_THRESHOLD;

const batches = new Map<string, VisionBatch>();
let submitted = 0;

const candidateOf = (item: {
  readonly id: string;
  readonly genericName: string;
  readonly strength: string;
  readonly form: string;
}): CandidateItem => ({
  id: item.id,
  name: item.genericName,
  strength: item.strength,
  form: item.form,
});

interface WriteContext {
  readonly store: LiveStore;
  readonly batchId: string;
  readonly facilityId: FacilityId;
  readonly occurredOn: DateOnly;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly index: number;
}

/**
 * Write one accepted line through the ingest boundary.
 *
 * The identifiers are derived from the queue's own identity rather than
 * generated fresh, so accepting the same line twice is a replay of one
 * submission rather than two movements of the same stock — the property that
 * makes a flaky connection harmless here as well as at the capture surface.
 */
async function writeLine(
  context: WriteContext,
  line: StockExtractionLine,
  evidence: { readonly itemId: ItemId },
): Promise<IngestReceipt> {
  const submission = visionIngestRequestFor({
    facilityId: context.facilityId,
    itemId: evidence.itemId,
    line,
    occurredOn: context.occurredOn,
    capturedAt: context.capturedAt,
    entryId: `entry-${context.batchId}-${String(context.index)}`,
    idempotencyKey: `key-${context.batchId}-${String(context.index)}`,
  });

  const { decision } = await applySubmission(context.store, submission, context.receivedAt);
  if (decision.outcome === 'conflict') {
    throw new VisionRefused(409, decision.detail);
  }

  return decision.receipt;
}

export interface RecordExtractionInput {
  readonly session: Session;
  readonly facilityId: FacilityId;
  readonly extraction: StockExtraction;
  readonly occurredOn: DateOnly;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly source: ReadingSource;
  readonly model: string;
  readonly cacheHit: boolean;
}

/**
 * Take a reading into the platform.
 *
 * Every line is listed in the result whether it was written or held back: an
 * extraction a person cannot see in full is not reviewable, and the accepted
 * lines are shown with the receipt they were written under.
 */
export async function recordExtraction(input: RecordExtractionInput): Promise<VisionBatch> {
  const store = await getLiveStore();

  if (!canSubmitForFacility(input.session, input.facilityId, store.scope)) {
    throw new VisionRefused(403, scopeRefusalFor(input.session, 'facility'));
  }

  const partition = partitionExtraction({
    extraction: input.extraction,
    catalogue: store.catalogue,
    occurredOn: input.occurredOn,
  });

  const acceptedByIndex = new Map(partition.accepted.map((line) => [line.index, line] as const));
  const reviewedByIndex = new Map(partition.review.map((line) => [line.index, line] as const));
  const facility = store.dataset.network.facilities.find((entry) => entry.id === input.facilityId);

  submitted += 1;
  const id = `vision-${String(submitted)}`;

  const lines: VisionLine[] = [];
  for (const [index, line] of input.extraction.lines.entries()) {
    const reviewed = reviewedByIndex.get(index);
    if (reviewed !== undefined) {
      lines.push({
        index,
        line,
        extracted: line,
        itemId: null,
        itemName: null,
        candidates: reviewed.candidates.map(candidateOf),
        reasons: reviewed.reasons,
        decision: 'pending',
        decidedBy: null,
        receipt: null,
      });
      continue;
    }

    const accepted = acceptedByIndex.get(index);
    if (accepted === undefined) {
      throw new VisionRefused(500, `line ${String(index)} was neither accepted nor held back`);
    }

    const receipt = await writeLine(
      {
        store,
        batchId: id,
        facilityId: input.facilityId,
        occurredOn: input.occurredOn,
        capturedAt: input.capturedAt,
        receivedAt: input.receivedAt,
        index,
      },
      line,
      { itemId: accepted.item.id },
    );

    lines.push({
      index,
      line,
      extracted: line,
      itemId: accepted.item.id,
      itemName: accepted.item.genericName,
      candidates: [],
      reasons: [],
      decision: 'accepted',
      decidedBy: null,
      receipt,
    });
  }

  const batch: VisionBatch = {
    id,
    facilityId: input.facilityId,
    facilityName: facility?.name ?? input.facilityId,
    occurredOn: input.occurredOn,
    capturedAt: input.capturedAt,
    receivedAt: input.receivedAt,
    source: input.source,
    model: input.model,
    cacheHit: input.cacheHit,
    registerDate: input.extraction.registerDate,
    pageNotes: input.extraction.notes,
    lines,
  };

  batches.set(batch.id, batch);
  return batch;
}

/** The batches a session may act on, in the order they arrived. */
export async function visionQueue(session: Session): Promise<readonly VisionBatch[]> {
  const store = await getLiveStore();

  return [...batches.values()].filter((batch) =>
    canSubmitForFacility(session, batch.facilityId, store.scope),
  );
}

export interface LineCorrections {
  /** A catalogue entry a person chose in place of the name the page wrote. */
  readonly itemId?: string | undefined;
  readonly quantity?: number | undefined;
  readonly batchId?: BatchId | null | undefined;
  readonly expiresOn?: string | null | undefined;
}

export interface DecideLineInput {
  readonly session: Session;
  readonly batchId: string;
  readonly index: number;
  readonly decision: 'accept' | 'discard';
  readonly corrections?: LineCorrections | undefined;
}

/**
 * Carry out a person's decision about one held-back line.
 *
 * Accepting runs the line back through the rule — with the person's choice of
 * item and the values they corrected — so a line that is still unacceptable is
 * refused with its reasons instead of being written because somebody clicked.
 * What a person changes is the evidence, never the rule.
 */
export async function decideVisionLine(input: DecideLineInput): Promise<VisionBatch> {
  const store = await getLiveStore();
  const batch = batches.get(input.batchId);

  if (batch === undefined) {
    throw new VisionRefused(404, `no extraction is queued under "${input.batchId}"`);
  }
  if (!canSubmitForFacility(input.session, batch.facilityId, store.scope)) {
    throw new VisionRefused(403, scopeRefusalFor(input.session, 'facility'));
  }

  const line = batch.lines.find((entry) => entry.index === input.index);
  if (line === undefined) {
    throw new VisionRefused(404, `that extraction has no line ${String(input.index)}`);
  }
  if (line.decision !== 'pending') {
    throw new VisionRefused(409, `that line was already ${line.decision}`);
  }

  if (input.decision === 'discard') {
    return replaceLine(batch, { ...line, decision: 'discarded', decidedBy: input.session.label });
  }

  const corrections = input.corrections ?? {};
  // A person looking at the page and at the catalogue has read the line, so it
  // is no longer unsure: its confidence is the review, not a model's guess.
  const corrected: StockExtractionLine = {
    ...line.line,
    quantity: corrections.quantity ?? line.line.quantity,
    batchId: corrections.batchId === undefined ? line.line.batchId : corrections.batchId,
    expiresOn: corrections.expiresOn === undefined ? line.line.expiresOn : corrections.expiresOn,
    confidence: 1,
  };

  const decided = decideLine({
    line: corrected,
    catalogue: store.catalogue,
    occurredOn: batch.occurredOn,
    ...(corrections.itemId === undefined ? {} : { chosenItemId: corrections.itemId }),
  });

  if (decided.reasons.length > 0 || decided.item === null) {
    throw new VisionRefused(
      409,
      decided.reasons.length > 0
        ? `that line still cannot be written: ${decided.reasons.join(', ')}`
        : 'that line has no item to write against',
    );
  }

  const item = decided.item;
  const receipt = await writeLine(
    {
      store,
      batchId: batch.id,
      facilityId: batch.facilityId,
      occurredOn: batch.occurredOn,
      capturedAt: batch.capturedAt,
      receivedAt: new Date().toISOString(),
      index: line.index,
    },
    corrected,
    { itemId: item.id },
  );

  return replaceLine(batch, {
    ...line,
    line: corrected,
    itemId: item.id,
    itemName: item.genericName,
    candidates: [],
    reasons: [],
    decision: 'accepted',
    decidedBy: input.session.label,
    receipt,
  });
}

function replaceLine(batch: VisionBatch, line: VisionLine): VisionBatch {
  const updated: VisionBatch = {
    ...batch,
    lines: batch.lines.map((entry) => (entry.index === line.index ? line : entry)),
  };
  batches.set(updated.id, updated);
  return updated;
}
