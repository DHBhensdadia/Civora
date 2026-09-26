import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { isCommandTier, readCommandTower } from '@/lib/command-service';
import { surfaceRefusal } from '@/lib/guard';
import { SESSION_COOKIE, parseSession } from '@/lib/session';

/**
 * The control tower as JSON.
 *
 * The same read the page renders, so a browser journey can assert the figures
 * rather than the layout, and so a future client — a state's own dashboard —
 * reads one implementation instead of a copy. The surface guard is applied here
 * exactly as the page applies it: a role that is not offered the tower is
 * refused with a sentence, not served a partial country.
 *
 * `?tier=` selects the aggregation; an unknown tier is the state rollup rather
 * than an error, because a URL with a typo in it should show a picture, not a
 * stack trace — and the payload reports the tier it actually used.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);
  const refusal = surfaceRefusal(session, '/command');
  if (refusal !== null) {
    return refusal;
  }

  const requested = request.nextUrl.searchParams.get('tier') ?? undefined;
  const tower = await readCommandTower(session, {
    tier: isCommandTier(requested) ? requested : undefined,
  });

  return NextResponse.json({
    ...tower,
    simulated: true,
    note: 'Assembled from the ledger projection, the scored population and the seeded network. No figure here is recomputed by this route.',
  });
}
