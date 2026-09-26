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
import type { AuditSubjectType, IngestDecision, IngestRequest } from '@civora/domain';

import { recordAuditEvent } from './audit-service';
import type { AuditActor, AuditAction } from './audit-service';
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
 * retry is answered from. The audit entry is written before it, for the same
 * reason: the chain should carry a movement a retry might still be recovering
 * from, and it must not carry one that was never stored.
 *
 * What is *not* recorded, deliberately: a replay (the record was already there,
 * so nothing changed), a conflict (it is written to the conflict collection,
 * which is where a disagreement is meant to be read, and it changes no
 * observation) and a refused submission (it never reaches here). The chain is for
 * what changed.
 */

/**
 * The observation types and the audit subjects they are recorded as.
 *
 * Written out rather than derived, so that adding an observation type without
 * deciding how the chain names it is a compile error instead of a silently
 * mislabelled record.
 */
const AUDIT_SUBJECT_TYPE_FOR_OBSERVATION = {
  stock_ledger_entry: 'stock_ledger_entry',
  bed_status: 'bed_status',
  staff_attendance: 'staff_attendance',
  footfall_observation: 'footfall_observation',
  syndromic_signal: 'syndromic_signal',
} as const satisfies Readonly<Record<IngestRequest['type'], AuditSubjectType>>;

/** What one stored observation adds to the chain. */
interface ConsequentialWrite {
  readonly action: AuditAction;
  readonly subjectType: AuditSubjectType;
  readonly reason: string | null;
}

/**
 * Which consequential action a stored observation is.
 *
 * A stock correction is separated from a capture because it is the movement a
 * reviewer most wants to find on its own: a count adjusted outside a delivery is
 * how stock disappears, and an event that does not single it out makes it
 * something nobody finds. Its entry carries the movement itself — item,
 * direction, quantity, day and place — because the observation has no note field
 * and a reason invented for it would be this platform's words in a facility's
 * mouth. Every other type is a capture, with the record's own type as its
 * subject so a filter can name one kind.
 */
function consequentialOf(submission: IngestRequest): ConsequentialWrite {
  // Narrowed on the envelope's discriminant, which is what makes the fields below
  // visible: the observation itself carries no `type` of its own.
  if (submission.type === 'stock_ledger_entry' && submission.observation.kind === 'adjust') {
    const entry = submission.observation;
    const direction = entry.adjustmentDirection === 'decrease' ? 'down' : 'up';
    return {
      action: 'adjustment-recorded',
      subjectType: 'stock_ledger_entry',
      reason: `corrected ${entry.itemId} ${direction} by ${String(entry.quantity)} at ${entry.facilityId} for ${entry.occurredOn}`,
    };
  }

  return {
    action: 'capture-recorded',
    subjectType: AUDIT_SUBJECT_TYPE_FOR_OBSERVATION[submission.type],
    reason: null,
  };
}

export interface AppliedSubmission {
  readonly subjectKey: string;
  readonly decision: IngestDecision;
}

export async function applySubmission(
  store: LiveStore,
  submission: IngestRequest,
  receivedAt: string,
  /** Who is submitting. Used for the audit entry, never for the ingest decision. */
  actor: AuditActor,
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

    const consequential = consequentialOf(submission);
    await recordAuditEvent({
      actor,
      action: consequential.action,
      subjectType: consequential.subjectType,
      subjectId: subjectKey,
      reason: consequential.reason,
    });
  }

  if (decision.conflict !== null) {
    await store.provider
      .collection(CONFLICT_COLLECTION, syncConflictSchema)
      .set(decision.conflict.id, decision.conflict);
  }

  await receipts.set(submission.idempotencyKey, decision.receipt);

  return { subjectKey, decision };
}
