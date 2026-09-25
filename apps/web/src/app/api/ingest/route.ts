import {
  CONFLICT_COLLECTION,
  OBSERVATION_COLLECTIONS,
  OBSERVATION_SCHEMAS,
  RECEIPT_COLLECTION,
  assertCaptureTimePlausible,
  decideIngest,
  ingestReceiptSchema,
  ingestRequestSchema,
  subjectKeyOfRequest,
  syncConflictSchema,
} from '@civora/domain';
import type { IngestStamp, Provenance } from '@civora/domain';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { getLiveStore } from '@/lib/live-store';
import { SESSION_COOKIE, canSubmitForFacility, parseSession, scopeRefusalFor } from '@/lib/session';

/**
 * Where a captured observation enters the platform.
 *
 * The boundary does four things, in this order, and the order matters:
 *
 *  1. **Validate** against the domain schema for the type the client declared,
 *     so a malformed capture is reported against the field that is wrong.
 *  2. **Authorise** the session for the facility it is writing to. A capture
 *     form is not a way to write another facility's ledger.
 *  3. **Decide** what the submission is — accepted, a replay of a key already
 *     seen, a duplicate of a record already held, or a disagreement with what is
 *     stored — through the pure rules in `@civora/domain`.
 *  4. **Persist** the outcome: the record, the receipt that makes a retry
 *     answerable, and the conflict record if there was one.
 *
 * Nothing here is a transaction, and that is a known limit of this adapter: an
 * in-process store cannot offer one. What the design does instead is make every
 * step idempotent — the receipt is keyed by the client's key and the record by
 * its natural identity — so a retry after a half-completed write converges on
 * the same state rather than duplicating it.
 */

export const dynamic = 'force-dynamic';

/**
 * How this build labels what a capture surface sends.
 *
 * The demonstration runs on generated data, so a capture submitted through it is
 * a simulated capture and says so. The stamp is applied by the platform, after
 * the client's payload and in place of anything the client claimed, so a device
 * can neither have its data believed nor have it discarded by asserting its own
 * provenance. A deployment with real facilities changes this one value.
 */
const CAPTURE_STAMP: IngestStamp = {
  synthetic: true,
  provenance: { kind: 'simulated', reference: 'capture-surface' } satisfies Provenance,
};

interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

const issuesOf = (
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): FieldIssue[] =>
  issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join('.'),
    message: issue.message,
  }));

/**
 * Fill in the fields the platform owns before validating.
 *
 * The observation schemas are the stored shape, so they require the fields the
 * platform stamps. A capture client has no business deciding them, and a form
 * should not have to send placeholders for them either — so they are supplied
 * here, validated as part of the request, and then replaced by the stamp below.
 * A client that sends them anyway is not refused; it is simply ignored.
 */
function withPlatformFields(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) {
    return body;
  }

  const observation = Reflect.get(body, 'observation');
  if (typeof observation !== 'object' || observation === null) {
    return body;
  }

  return {
    ...body,
    observation: {
      ...observation,
      recordedAt: Reflect.get(body, 'capturedAt'),
      captureSource: Reflect.get(body, 'captureSource'),
      // The record's own retry key, which the replay of the ledger deduplicates
      // on. A client that submits several observations under one submission key
      // supplies one per record; a client submitting one inherits the
      // submission's, which is the key it will reuse on every retry.
      idempotencyKey:
        Reflect.get(observation, 'idempotencyKey') ?? Reflect.get(body, 'idempotencyKey'),
      synthetic: CAPTURE_STAMP.synthetic,
      provenance: CAPTURE_STAMP.provenance,
    },
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const receivedAt = new Date().toISOString();
  const store = await getLiveStore();
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { outcome: 'rejected', reason: 'malformed-json', detail: 'the request body must be JSON' },
      { status: 400 },
    );
  }

  const parsed = ingestRequestSchema.safeParse(withPlatformFields(body));
  if (!parsed.success) {
    return NextResponse.json(
      {
        outcome: 'rejected',
        reason: 'invalid-observation',
        detail: 'the submission does not match the contract for the type it declared',
        issues: issuesOf(parsed.error.issues),
      },
      { status: 400 },
    );
  }

  const submission = parsed.data;

  if (!canSubmitForFacility(session, submission.observation.facilityId, store.scope)) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'out-of-scope',
        detail: scopeRefusalFor(session, 'facility'),
        facilityId: submission.observation.facilityId,
      },
      { status: 403 },
    );
  }

  try {
    // A device whose clock is a day ahead cannot be ordered against anything,
    // so it is refused rather than filed. The record is not lost: the client
    // keeps it in its outbox and a corrected clock delivers it.
    assertCaptureTimePlausible(submission.capturedAt, receivedAt);
  } catch (error) {
    return NextResponse.json(
      {
        outcome: 'rejected',
        reason: 'implausible-capture-time',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 400 },
    );
  }

  const receipts = store.provider.collection(RECEIPT_COLLECTION, ingestReceiptSchema);
  const observations = store.provider.collection(
    OBSERVATION_COLLECTIONS[submission.type],
    OBSERVATION_SCHEMAS[submission.type],
  );
  const subjectKey = subjectKeyOfRequest(submission);

  const existingReceipt = await receipts.get(submission.idempotencyKey);
  const existingRecord = await observations.get(subjectKey);

  const decision = decideIngest({
    request: submission,
    receivedAt,
    existingReceipt,
    existingRecord,
    stamp: CAPTURE_STAMP,
    conflictId: `conflict-${subjectKey}-${submission.idempotencyKey}`,
  });

  if (decision.record !== null) {
    await observations.set(subjectKey, decision.record);
    // The projection reads what was observed, and the stamp is bookkeeping, so
    // the submission carries everything the dashboard needs.
    store.ledger.applyRequest(submission);
  }

  if (decision.conflict !== null) {
    await store.provider
      .collection(CONFLICT_COLLECTION, syncConflictSchema)
      .set(decision.conflict.id, decision.conflict);
  }

  // Written last, so a failure before this point leaves a submission that a
  // retry can still process, and a failure after it leaves a submission that a
  // retry is answered from the receipt.
  await receipts.set(submission.idempotencyKey, decision.receipt);

  return NextResponse.json(
    {
      outcome: decision.outcome,
      detail: decision.detail,
      subjectKey,
      receipt: decision.receipt,
      conflict: decision.conflict,
      facilityId: submission.observation.facilityId,
      type: submission.type,
    },
    { status: decision.outcome === 'conflict' ? 409 : 200 },
  );
}
