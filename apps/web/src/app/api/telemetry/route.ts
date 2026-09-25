import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { SESSION_COOKIE, parseSession } from '@/lib/session';
import { readTelemetry } from '@/lib/telemetry-service';

/**
 * What the reasoning layer has been asked to do.
 *
 * A read with no side effects on the reasoning path: it reports the adapter's own
 * counters and derives what a burst would cost from the inbox the session may
 * read. It is safe to poll, which the panel on `/intelligence` does — unlike the
 * advisory read beside it, whose first call is what writes the bodies.
 *
 * There is no POST. Nothing about these numbers is a decision a caller makes;
 * the only way to move them is to use the surfaces that make calls.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  return NextResponse.json(await readTelemetry(session));
}
