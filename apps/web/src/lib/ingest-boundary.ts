import {
  CONFLICT_COLLECTION,
  OBSERVATION_COLLECTIONS,
  OBSERVATION_SCHEMAS,
  PLATFORM_STAMP,
  RECEIPT_COLLECTION,
  decideIngest,
  ingestReceiptSchema,
  subjectKeyOfRequest,
  syncConflictSchema,
} from '@civora/domain';
import type { IngestDecision, IngestRequest } from '@civora/domain';

import type { LiveStore } from './live-store';

/**
 * Where a validated observation is written, once.
 *
 * The ingest boundary and the vision intake path both end here: a submission
 * arrives already validated and already authorised, and everything that follows
 * is identical — decide it against what is stored, write the record if the
 * decision produced one, update the projection from the *submission* rather than
 * the stamped record (the stamp is bookkeeping; the submission carries what was
 * observed), record the conflict if there was one, and write the receipt last.
 *
 * One implementation rather than two, because two copies of this sequence would
 * drift exactly where it is least visible — the receipt that makes a retry
 * answerable — and a captured record would then be stored by one path and not
 * replayable by the other.
 *
 * The receipt is written last on purpose: a failure before it leaves a
 * submission a retry can still process, and a failure after it leaves one that a
 * retry is answered from.
 */
export interface AppliedSubmission {
  readonly subjectKey: string;
  readonly decision: IngestDecision;
}

export async function applySubmission(
  store: LiveStore,
  submission: IngestRequest,
  receivedAt: string,
): Promise<AppliedSubmission> {
  const receipts = store.provider.collection(RECEIPT_COLLECTION, ingestReceiptSchema);
  const observations = store.provider.collection(
    OBSERVATION_COLLECTIONS[submission.type],
    OBSERVATION_SCHEMAS[submission.type],
  );
  const subjectKey = subjectKeyOfRequest(submission);

  const decision = decideIngest({
    request: submission,
    receivedAt,
    existingReceipt: await receipts.get(submission.idempotencyKey),
    existingRecord: await observations.get(subjectKey),
    stamp: PLATFORM_STAMP,
    conflictId: `conflict-${subjectKey}-${submission.idempotencyKey}`,
  });

  if (decision.record !== null) {
    await observations.set(subjectKey, decision.record);
    store.ledger.applyRequest(submission);
  }

  if (decision.conflict !== null) {
    await store.provider
      .collection(CONFLICT_COLLECTION, syncConflictSchema)
      .set(decision.conflict.id, decision.conflict);
  }

  await receipts.set(submission.idempotencyKey, decision.receipt);

  return { subjectKey, decision };
}
