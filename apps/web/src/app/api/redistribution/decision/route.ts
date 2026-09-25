import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { ProposalRefused, decideTransferProposal } from '@/lib/redistribution-service';
import { SESSION_COOKIE, parseSession } from '@/lib/session';

/**
 * Approving or rejecting one proposal.
 *
 * The only write path onto a proposal, and it is deliberately a decision with a
 * reason rather than an assignment: the request says what the person decided and
 * why, the platform records who they were from the session — never from the body
 * — and both the proposal and the audit chain end up with the same actor, moment
 * and grounds. A client that sent `approvals: [...]` would be asking the platform
 * to record a decision nobody made.
 *
 * The refusals are structured — unknown proposal, a request that is not a
 * decision (no reason), authority this session does not have, a decision already
 * taken — so the interface can show the reason it was actually refused. Nothing
 * is silently clamped: a refused decision leaves both records exactly as they
 * were.
 */

export const dynamic = 'force-dynamic';

const decisionSchema = z.strictObject({
  proposalId: z.string().trim().min(1),
  decision: z.enum(['approved', 'rejected']),
  // Empty is allowed through to the rule rather than rejected here, so a caller
  // that forgets the reason gets the sentence explaining why it matters instead
  // of a schema error about a field's length.
  reason: z.string().trim().max(600),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { outcome: 'refused', reason: 'malformed-body', detail: 'the request body is not JSON' },
      { status: 400 },
    );
  }

  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'invalid-decision',
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; '),
      },
      { status: 400 },
    );
  }

  try {
    const decided = await decideTransferProposal(session, {
      proposalId: parsed.data.proposalId,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
    });

    return NextResponse.json({
      outcome: 'decided',
      proposal: decided.proposal,
      decision: decided.decision,
      // The proposal is derived from a generated world; the decision is a
      // person's. Both labels are on the record rather than one standing in for
      // the other.
      simulated: decided.proposal.synthetic,
    });
  } catch (error) {
    if (error instanceof ProposalRefused) {
      const reasons: Readonly<Record<number, string>> = {
        404: 'unknown-proposal',
        400: 'not-a-decision',
        403: 'not-permitted',
        409: 'already-decided',
      };
      return NextResponse.json(
        {
          outcome: 'refused',
          reason: reasons[error.status] ?? 'not-permitted',
          detail: error.message,
        },
        { status: error.status },
      );
    }
    throw error;
  }
}
