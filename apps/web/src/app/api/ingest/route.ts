import {
  PLATFORM_STAMP,
  assertCaptureTimePlausible,
  completeSubmission,
  ingestRequestSchema,
} from '@civora/domain';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { applySubmission } from '@/lib/ingest-boundary';
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

  // Completed from the submission's envelope and this build's stamp before it is
  // validated, so the contract the boundary accepts is exactly the one a capture
  // surface can satisfy: a client sends what it observed, and the platform
  // supplies the rest.
  const parsed = ingestRequestSchema.safeParse(completeSubmission(body, PLATFORM_STAMP));
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

  // The write itself is shared with every other path that stores an
  // observation, so a record can be captured by one surface and replayed by
  // another without either owning its own copy of the sequence.
  const { subjectKey, decision } = await applySubmission(store, submission, receivedAt);

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
