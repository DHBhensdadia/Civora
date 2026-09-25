import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { readAdvisorySet } from '@/lib/advisory-service';
import { SESSION_COOKIE, parseSession } from '@/lib/session';

/**
 * The advisories for the active alert set.
 *
 * A GET is the ordinary read: it answers with the bodies this process holds, and
 * it writes them if this is the first time anybody has asked — for the whole set,
 * in every language the record carries, before any single alert row is opened.
 * That is the phase's requirement in its plainest form: the demo must not depend
 * on a live burst of model calls at the moment it is judged, so the bodies exist
 * before a reader arrives and the second read is answered from the process.
 *
 * The POST is the one thing that re-asks. It exists because a refusal is a
 * normal outcome — this build has no key, so every language refuses — and a
 * platform whose only answer to "the writer was not available" is a dead end
 * would be a platform nobody can operate. It is scoped to the alerts the session
 * may read, like every other read here.
 */

export const dynamic = 'force-dynamic';

const regenerateSchema = z.strictObject({ regenerate: z.literal(true) });

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  return NextResponse.json({
    ...(await readAdvisorySet(session)),
    // The bodies are prose about a generated alert; the alert itself is
    // simulated, and saying so here as well is what keeps a reader from taking
    // the numbers inside a body for a real facility's position.
    simulated: true,
  });
}

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

  const parsed = regenerateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'not-a-regeneration',
        detail:
          'this route re-asks only when the request says so literally: send {"regenerate": true}',
      },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ...(await readAdvisorySet(session, { regenerate: true })),
    simulated: true,
  });
}
