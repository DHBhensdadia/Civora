import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { readRationaleSet } from '@/lib/rationale-service';
import { SESSION_COOKIE, parseSession } from '@/lib/session';

/**
 * The rationales for the proposals the session can see.
 *
 * A GET is the ordinary read: it answers with what this process holds, and it
 * writes the set if this is the first time anybody has asked — once, for every
 * proposal on the workbench, before a single row is opened. That is the same
 * discipline as the advisory set: the demo must not depend on a live burst of
 * model calls at the moment it is judged.
 *
 * The POST is the one thing that re-asks, and it exists because a refusal is a
 * normal outcome — this build has no key, so every proposal refuses — and a
 * platform whose only answer to "the writer was not available" is a dead end
 * would be a platform nobody can operate. It is scoped to the proposals the
 * session may read, like every other read here.
 */

export const dynamic = 'force-dynamic';

const regenerateSchema = z.strictObject({ regenerate: z.literal(true) });

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  return NextResponse.json({
    ...(await readRationaleSet(session)),
    // The rationale is prose about a proposal derived from a generated world;
    // the proposal itself is simulated, and saying so here as well is what keeps
    // a reader from taking a figure inside the explanation for a real position.
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
    ...(await readRationaleSet(session, { regenerate: true })),
    simulated: true,
  });
}
