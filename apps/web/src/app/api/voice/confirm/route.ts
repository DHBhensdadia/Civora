import { batchIdSchema, dateSchema, itemIdSchema } from '@civora/domain';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { SESSION_COOKIE, parseSession } from '@/lib/session';
import { VoiceRefused, confirmVoiceCommand } from '@/lib/voice-service';

/**
 * A person's confirmation of what they were shown.
 *
 * The only path from a spoken update into the ledger. Two things are deliberate
 * about the shape of this request:
 *
 *  - **`confirm` is `true`, literally.** A default, an absent field or a truthy
 *    string is not a confirmation, so a client cannot write a spoken record by
 *    forgetting to send something. The person who spoke — or the person holding
 *    the phone — has to say yes.
 *  - **The corrections are the questions the platform asked, and nothing else.**
 *    The item a name meant, the batch and expiry of arriving stock, the number of
 *    filled posts that turned up. Each is applied to the parse and re-validated
 *    against the command's own schema, so the confirmation screen cannot be used
 *    to build a record the platform would have refused from a model.
 *
 * On confirming, the rule runs again with those corrections in front of it. A
 * proposal that is still incomplete is refused with the questions that remain,
 * rather than written because somebody pressed confirm.
 */

export const dynamic = 'force-dynamic';

const confirmationSchema = z.strictObject({
  id: z.string().trim().min(1),
  confirm: z.literal(true),
  corrections: z
    .strictObject({
      /** The catalogue entry the spoken name meant. */
      itemId: itemIdSchema.optional(),
      batchId: batchIdSchema.nullish(),
      expiresOn: dateSchema.nullish(),
      presentToday: z.int().nonnegative().nullish(),
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

  const parsed = confirmationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'not-confirmed',
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; '),
      },
      { status: 400 },
    );
  }

  try {
    const proposal = await confirmVoiceCommand({
      session,
      id: parsed.data.id,
      ...(parsed.data.corrections === undefined ? {} : { corrections: parsed.data.corrections }),
    });

    return NextResponse.json({
      outcome: proposal.receipt === null ? 'pending' : 'written',
      proposal,
      // A confirmation is a person's act, so it is not simulated even though the
      // parse it is about came out of a model over a generated dataset. The
      // record itself still carries the platform's simulated stamp.
      confirmedBy: session.label,
    });
  } catch (error) {
    if (error instanceof VoiceRefused) {
      return NextResponse.json(
        { outcome: 'refused', reason: 'not-confirmed', detail: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
