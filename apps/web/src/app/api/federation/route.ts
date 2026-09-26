import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { actorOf } from '@/lib/audit-service';
import { readFederationConsole } from '@/lib/federation-service';
import { SESSION_COOKIE, parseSession } from '@/lib/session';

/**
 * Samvad's read: the rounds, the ledger, the ε and the boundary.
 *
 * One payload, computed once per process over the demonstration world. It carries
 * both runs on purpose — the algorithmic one, which is where the federation's
 * effect is measured, and the priced one, which is where the privacy guarantee and
 * its cost are — plus the curve and the round narratives, so a reader of this route
 * sees the same numbers the page and the batch commands see.
 *
 * The session is read because these rounds consume a privacy budget: the chain
 * records who caused the first computation in this process, and the payload does
 * not depend on who is reading it.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json(await readFederationConsole(actorOf(session)));
}
