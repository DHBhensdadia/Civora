import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { CORRELATION_HEADER, logHandled } from '@/lib/log';
import { metricsSummaryOf } from '@/lib/observability';
import { SESSION_COOKIE, canReadAuditChain, parseSession } from '@/lib/session';

/**
 * What this process has done, in one read.
 *
 * The operation summary is read by the two roles that already read the whole
 * record — the control room and the auditor — because it is a country-wide view of
 * the platform's own work: how many entries the chain holds and of which actions,
 * which files were imported and how much they wrote, how many scans the memo
 * answered, and what the reasoning adapter reports about its own calls. A district
 * officer reading it would be reading a summary of other districts' decisions,
 * which is the same tenancy rule that keeps them out of the chain.
 *
 * Every figure is read through the mechanism that owns it. Nothing here recomputes
 * a projection, a plan or a score, and `null` is what an unmeasured thing reports.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  if (!canReadAuditChain(session)) {
    logHandled({
      correlationId: request.headers.get(CORRELATION_HEADER) ?? 'unrecorded',
      method: request.method,
      path: '/api/metrics',
      status: 403,
      durationMs: Date.now() - started,
    });

    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'not-permitted',
        detail: `${session.label} is scoped to a place, and this summary covers the whole platform; it is read by the control room and the auditor`,
      },
      { status: 403 },
    );
  }

  const metrics = await metricsSummaryOf();

  logHandled({
    correlationId: request.headers.get(CORRELATION_HEADER) ?? 'unrecorded',
    method: request.method,
    path: '/api/metrics',
    status: 200,
    durationMs: Date.now() - started,
  });

  return NextResponse.json({ outcome: 'read', metrics });
}
