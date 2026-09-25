import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { ROW_LIMIT, readIntelligence } from '@/lib/intelligence-service';
import { SESSION_COOKIE, parseSession } from '@/lib/session';

/**
 * What the platform concludes about stock-out risk, and who is asked to act.
 *
 * The read model behind the intelligence surface: a risk-ranked list with every
 * driver's contribution and sentence, the epidemic signals the forecasts were
 * lifted for, and the alert inbox. Every figure comes from one scoring run at one
 * `asOf` — the pipeline is the same one `worker:score` runs, imported rather than
 * reimplemented, so a number here can be reproduced by a command.
 *
 * The list is capped and says so. Sending several hundred rows to a browser to be
 * scrolled past is a slower way of sending the summary above them; the cap and
 * the total are both in the payload, so nothing is hidden by the truncation.
 *
 * Reads are scoped to the session, exactly as the visibility route is, and the
 * payload says whether the reader is seeing the whole country or their own
 * districts rather than leaving it to be inferred.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);
  const intelligence = await readIntelligence(session);

  const districtFilter = request.nextUrl.searchParams.get('districtId');

  const rows =
    districtFilter === null
      ? intelligence.rows
      : intelligence.rows.filter((row) => row.districtId === districtFilter);

  return NextResponse.json({
    session: { role: session.role, label: session.label, scopeId: session.scopeId },
    asOf: intelligence.asOf,
    horizonDays: intelligence.horizonDays,
    scoredInMs: intelligence.scoredInMs,
    pairsScored: intelligence.pairsScored,
    pairsListed: rows.length,
    rowLimit: ROW_LIMIT,
    liftedForecasts: intelligence.liftedForecasts,
    bands: intelligence.bands,
    rows,
    alerts: intelligence.alerts,
    events: intelligence.events,
    scope: {
      wholeCountry: intelligence.national,
      districtFilter,
      description: intelligence.national
        ? 'this session reads the whole country'
        : 'this session reads only the districts it is responsible for; the rest is withheld, not counted and dropped',
    },
    store: {
      seed: intelligence.seed,
      scenarioId: intelligence.scenarioId,
      scenarioLabel: intelligence.scenarioLabel,
    },
    // Every number is derived from the generated dataset, and so is any capture
    // that has arrived through this platform's own ingest boundary.
    simulated: true,
  });
}
