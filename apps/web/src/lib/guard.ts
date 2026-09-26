import { NextResponse } from 'next/server';

import { mayReach, surfaceRefusalFor } from './navigation';
import type { Session } from './session';

/**
 * The guard in front of a surface a session is not offered.
 *
 * One function, used by the page and by the API route behind it, because the two
 * answering differently is the classic way a permission system leaks: the page
 * refuses and the JSON does not, or the navigation hides a link the route still
 * serves to anyone who types the address.
 *
 * The refusal is a **403 with a sentence**, not a 404. A hidden address is not an
 * unknown one: a reader who reaches it should be told which surface exists and
 * why their role is not offered it, which is the same principle the district
 * scoping already follows.
 */

export interface SurfaceAccess {
  readonly allowed: boolean;
  /** The sentence to show or return, or null when the surface is offered. */
  readonly refusal: string | null;
}

/** Whether a session may open a surface, and why not when it may not. */
export function accessTo(session: Session, href: string): SurfaceAccess {
  return mayReach(session, href)
    ? { allowed: true, refusal: null }
    : { allowed: false, refusal: surfaceRefusalFor(session, href) };
}

/** The JSON refusal for an API route, or null when the session may read it. */
export function surfaceRefusal(session: Session, href: string): NextResponse | null {
  const access = accessTo(session, href);
  if (access.allowed) {
    return null;
  }
  return NextResponse.json(
    { outcome: 'refused', reason: 'not-offered', detail: access.refusal },
    { status: 403 },
  );
}
