import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { CORRELATION_HEADER, logHandled } from '@/lib/log';
import { readinessOf } from '@/lib/observability';

/**
 * Whether this process should be given traffic.
 *
 * `/healthz` answers "is the process alive", which a container runtime needs and
 * which is a different question from "can it serve a decision". This one reads the
 * mechanisms and can refuse: a store that reports not ok, a dataset that was never
 * built, a projection with no day to project, or **an audit chain that does not
 * hold**. The last is the one a healthy process can still fail, and it is the
 * reason this endpoint is not a formality — a platform that cannot answer for its
 * own trail should not be handed the next decision.
 *
 * The answer is 200 with `ready: true`, or 503 with the failing check named. What
 * this process is *not* configured to do — a model key, for instance — is reported
 * under `capabilities` and does not make readiness false, because a demonstration
 * with no key is ready to serve and saying otherwise would be a claim about
 * ambition rather than capability.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  const readiness = await readinessOf();

  logHandled({
    correlationId: request.headers.get(CORRELATION_HEADER) ?? 'unrecorded',
    method: request.method,
    path: '/readyz',
    status: readiness.ready ? 200 : 503,
    durationMs: Date.now() - started,
  });

  return NextResponse.json(readiness, { status: readiness.ready ? 200 : 503 });
}
