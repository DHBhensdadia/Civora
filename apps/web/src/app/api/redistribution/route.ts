import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { readRedistribution } from '@/lib/redistribution-service';
import { SESSION_COOKIE, parseSession } from '@/lib/session';

/**
 * The workbench's read: the plan, its proposals and every figure behind them.
 *
 * One national plan, scoped for the reader, with what was hidden counted. The
 * payload carries the validator's verdict, the four strategies with the chosen
 * one marked, the impact assumptions, and the graph's own record of what it
 * refused — because a workbench that showed proposals without those would be
 * asking to be trusted rather than read.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json(await readRedistribution(session));
}
