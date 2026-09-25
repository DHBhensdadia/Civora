import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { SESSION_COOKIE, parseSession } from '@/lib/session';
import { VoiceRefused, discardVoiceCommand } from '@/lib/voice-service';

/**
 * Reject a parse: that is not what I said.
 *
 * The confirmation flow needs a way to say no. Without it the only options would
 * be to write something the speaker does not recognise or to leave it in the
 * queue for ever — and a queue that can only be emptied by writing would be a
 * queue that fills up with edits nobody made.
 *
 * The proposal is kept with the person's name against it rather than deleted,
 * because a rejected parse is the platform's only evidence about how the reader
 * performs on real speech and a flow that forgot its own mistakes could not
 * report them.
 */

export const dynamic = 'force-dynamic';

const discardSchema = z.strictObject({
  id: z.string().trim().min(1),
  discard: z.literal(true),
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

  const parsed = discardSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'invalid-discard',
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; '),
      },
      { status: 400 },
    );
  }

  try {
    const proposal = await discardVoiceCommand({ session, id: parsed.data.id });
    return NextResponse.json({ outcome: 'discarded', proposal, discardedBy: session.label });
  } catch (error) {
    if (error instanceof VoiceRefused) {
      return NextResponse.json(
        { outcome: 'refused', reason: 'not-discarded', detail: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
