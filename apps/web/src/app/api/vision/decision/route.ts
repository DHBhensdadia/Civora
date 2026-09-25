import { batchIdSchema, dateSchema, itemIdSchema } from '@civora/domain';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { SESSION_COOKIE, parseSession } from '@/lib/session';
import { VisionRefused, decideVisionLine } from '@/lib/vision-service';

/**
 * A person's decision about one line a model read.
 *
 * This is the only path from the review queue into the ledger, and it is a
 * decision about a *line* rather than about an extraction: approving a
 * photograph wholesale is not something the platform offers, because the whole
 * reason a line is here is that it cannot be written as read.
 *
 * The corrections are the person's reading of the page — the item the name meant,
 * a quantity, a batch, an expiry. They are passed to the same rule the intake
 * used, so a line that is still incomplete is refused with its reasons rather
 * than written because somebody pressed accept. What a person changes is the
 * evidence; the rule is not theirs to change.
 */

export const dynamic = 'force-dynamic';

const decisionSchema = z.strictObject({
  batchId: z.string().trim().min(1),
  index: z.int().nonnegative(),
  decision: z.enum(['accept', 'discard']),
  corrections: z
    .strictObject({
      /** The catalogue entry the written name meant. */
      itemId: itemIdSchema.optional(),
      quantity: z.int().nonnegative().optional(),
      batchId: batchIdSchema.nullish(),
      expiresOn: dateSchema.nullish(),
    })
    .optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { outcome: 'refused', reason: 'malformed-body', detail: 'the request body must be JSON' },
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
    const batch = await decideVisionLine({
      session,
      batchId: parsed.data.batchId,
      index: parsed.data.index,
      decision: parsed.data.decision,
      ...(parsed.data.corrections === undefined ? {} : { corrections: parsed.data.corrections }),
    });

    const line = batch.lines.find((entry) => entry.index === parsed.data.index);

    return NextResponse.json({
      outcome: parsed.data.decision === 'accept' ? 'accepted' : 'discarded',
      line,
      batch,
      // A decision is a person's, so it is not simulated even though the reading
      // it is about came out of a model over a generated dataset.
      decidedBy: session.label,
    });
  } catch (error) {
    if (error instanceof VisionRefused) {
      return NextResponse.json(
        { outcome: 'refused', reason: 'not-decided', detail: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
