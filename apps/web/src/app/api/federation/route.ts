import { NextResponse } from 'next/server';

import { readFederationConsole } from '@/lib/federation-service';

/**
 * Samvad's read: the rounds, the ledger, the ε and the boundary.
 *
 * One payload, computed once per process over the demonstration world. It carries
 * both runs on purpose — the algorithmic one, which is where the federation's
 * effect is measured, and the priced one, which is where the privacy guarantee and
 * its cost are — plus the curve and the round narratives, so a reader of this route
 * sees the same numbers the page and the batch commands see.
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await readFederationConsole());
}
