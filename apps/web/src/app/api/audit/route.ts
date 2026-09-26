import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { NO_AUDIT_FILTERS, readAuditTrail } from '@/lib/audit-service';
import type { AuditFilters } from '@/lib/audit-service';
import { SESSION_COOKIE, canReadAuditChain, parseSession } from '@/lib/session';

/**
 * The chain, as the viewer reads it.
 *
 * Two refusals are deliberate and one is structural. The refusal a reader sees is
 * the tenancy rule — the auditor and the control room, the same rule the stored
 * rules enforce — and it is a `403` with a sentence rather than an empty list,
 * because an empty list is indistinguishable from a chain with nothing in it.
 *
 * The verification in the payload always walks the *whole* chain, whatever the
 * filters ask for. A reader who narrowed to one actor must not be told the trail
 * is intact when the break is in a row they filtered away.
 *
 * Query parameters are the filters, and an absent one is no filter rather than an
 * empty string: `?actor=` asks for entries with no actor, which is a different
 * question from the one the interface means to ask when a select is cleared.
 */

export const dynamic = 'force-dynamic';

const filterOf = (request: NextRequest): AuditFilters => {
  const value = (name: string): string | null => {
    const raw = request.nextUrl.searchParams.get(name)?.trim() ?? '';
    return raw === '' ? null : raw;
  };

  return {
    ...NO_AUDIT_FILTERS,
    actor: value('actor'),
    action: value('action'),
    subject: value('subject'),
    from: value('from'),
    to: value('to'),
  };
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  if (!canReadAuditChain(session)) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'not-permitted',
        detail: `${session.label} is scoped to a place, and the chain holds every place's decisions; it is read by the auditor and the control room`,
      },
      { status: 403 },
    );
  }

  return NextResponse.json({ outcome: 'read', trail: await readAuditTrail(filterOf(request)) });
}
