import { ALERT_STATES } from '@civora/domain';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { AlertRefused, moveAlert } from '@/lib/intelligence-service';
import { SESSION_COOKIE, parseSession } from '@/lib/session';

/**
 * Moving an alert through its life.
 *
 * The only write path onto an alert, and it is deliberately a move rather than an
 * assignment: the request names where the alert is going and why, the domain's
 * transition table decides whether that is legal, and the result is an append to
 * the alert's history rather than a new state with no past. A client that sent
 * `state: 'resolved'` would be asking the platform to record a decision nobody
 * made.
 *
 * The refusals are structured — out of scope, read-only identity, no reason
 * given, illegal move — so the interface can show the reason it was actually
 * refused. Nothing is silently clamped: an alert that cannot be moved stays where
 * it is and the caller is told which rule stopped it.
 */

export const dynamic = 'force-dynamic';

const moveSchema = z.strictObject({
  alertId: z.string().trim().min(1),
  to: z.enum(ALERT_STATES),
  // Empty is allowed through to the rule rather than rejected here, so a caller
  // that forgets the reason gets the sentence explaining why it matters instead
  // of a schema error about a field's length.
  reason: z.string().trim().max(400),
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

  const parsed = moveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'invalid-move',
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; '),
      },
      { status: 400 },
    );
  }

  try {
    const alert = await moveAlert(session, {
      alertId: parsed.data.alertId,
      to: parsed.data.to,
      reason: parsed.data.reason,
    });

    return NextResponse.json({
      outcome: 'moved',
      alert,
      // A move is a decision by a person, so it is not simulated even though the
      // alert itself came out of a generated dataset. Saying which is which is
      // the point of the label.
      simulated: alert.synthetic,
    });
  } catch (error) {
    if (error instanceof AlertRefused) {
      const reasons: Readonly<Record<number, string>> = {
        404: 'unknown-alert',
        400: 'not-a-decision',
        403: 'not-permitted',
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
