import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { getLiveStore } from '@/lib/live-store';
import {
  NATIONAL_SESSION,
  SESSION_COOKIE,
  encodeSession,
  openingDistrictFor,
  parseSession,
} from '@/lib/session';
import type { Principal, Session } from '@/lib/session';

/**
 * Who the interface is acting as.
 *
 * A fixture rather than a sign-in: the platform's identity port is served by a
 * local adapter in this build, so the control here selects one of the fixture
 * identities the demonstration offers and writes it to a cookie. Everything
 * downstream — the ingest boundary, the visibility read — authorises the
 * resulting session through `lib/session.ts`, so replacing this route with real
 * sign-in is a change to this file and nothing else.
 *
 * The list of identities is built from the network rather than hard-coded, so a
 * scope can only ever name a facility, district or region that exists.
 */

export const dynamic = 'force-dynamic';

const payload = (
  session: Session,
  principals: readonly Principal[],
  openingDistrictId: string,
): Record<string, unknown> => ({
  session,
  principals,
  /** The district this session should be shown first, given its scope. */
  openingDistrictId,
  // The identities are fixtures. Saying so here as well as in the interface is
  // deliberate: a reader of the API should not have to infer it from a name.
  simulated: true,
  note: 'Fixture identities for the demonstration build. Real sign-in replaces this control and the rules it feeds are unchanged.',
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const store = await getLiveStore();
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);
  const selected = store.principals.find(
    (principal) => principal.role === session.role && principal.scopeId === session.scopeId,
  );
  const effective = selected ?? session;

  return NextResponse.json(
    payload(
      effective,
      store.principals,
      openingDistrictFor(effective, store.scope, store.defaultDistrictId),
    ),
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const store = await getLiveStore();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { outcome: 'rejected', detail: 'the request body must be JSON' },
      { status: 400 },
    );
  }

  const id =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'principalId') : undefined;
  const principal = store.principals.find((candidate) => candidate.id === id);

  // An unknown identity is refused rather than falling back to the default:
  // silently serving a wider scope than the caller asked for is the wrong
  // direction to fail in.
  if (principal === undefined) {
    return NextResponse.json(
      { outcome: 'refused', detail: `no such principal: ${String(id)}` },
      { status: 404 },
    );
  }

  const response = NextResponse.json(
    payload(
      principal,
      store.principals,
      openingDistrictFor(principal, store.scope, store.defaultDistrictId),
    ),
  );
  response.cookies.set({
    name: SESSION_COOKIE,
    value: encodeSession({
      role: principal.role,
      scopeId: principal.scopeId,
      label: principal.label,
    }),
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
  return response;
}

export async function DELETE(): Promise<NextResponse> {
  const store = await getLiveStore();
  const response = NextResponse.json(
    payload(
      NATIONAL_SESSION,
      store.principals,
      openingDistrictFor(NATIONAL_SESSION, store.scope, store.defaultDistrictId),
    ),
  );
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
