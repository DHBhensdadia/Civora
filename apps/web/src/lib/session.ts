import { ROLES } from '@civora/domain';
import type { Role } from '@civora/domain';
import { z } from 'zod';

/**
 * Who is acting, and what that entitles them to.
 *
 * This is the tenancy model, kept pure and separate from whatever authenticates
 * a person. The identity port returns a session; every route asks this module
 * what the session may do. Swapping the development sign-in fixtures for real
 * sign-in therefore changes one adapter and no rule — and a rule cannot be
 * weakened by an adapter that returns a session with a wider scope than it
 * should, because the scope is part of the validated shape.
 *
 * The scopes are the administrative spine: a facility for front-line staff, a
 * district for the level at which redistribution authority sits, a state for
 * the level that owns the district stores, and the country for the control
 * room. An auditor reads everything and writes nothing.
 */

export const SESSION_COOKIE = 'civora-session';

export const sessionSchema = z.strictObject({
  role: z.enum(ROLES),
  /**
   * The administrative anchor for the role.
   *
   * A facility identifier for front-line staff, a district for a district
   * officer, a state for a state officer, and null for the roles that are not
   * scoped to a place.
   */
  scopeId: z.string().trim().min(1).nullable(),
  /** How the interface names this person. Never used for an authorisation decision. */
  label: z.string().trim().min(1),
});

export type Session = z.infer<typeof sessionSchema>;

/** The session a request is treated as having when it presents none. */
export const NATIONAL_SESSION: Session = {
  role: 'national',
  scopeId: null,
  label: 'National control room',
};

/** One selectable identity, with everything needed to authorise it. */
export interface Principal extends Session {
  /** Stable identifier for the fixture, used by the sign-in control. */
  readonly id: string;
  /** The place this principal is anchored to, for display. */
  readonly place: string;
}

/** Just enough of the administrative tree to resolve a scope. */
export interface ScopeLookup {
  /** The district a facility belongs to, or null if the facility is unknown here. */
  readonly districtOfFacility: (facilityId: string) => string | null;
  /** The region a district belongs to, or null if the district is unknown here. */
  readonly regionOfDistrict: (districtId: string) => string | null;
  /** The districts a region contains, so a scoped read has somewhere to open. */
  readonly districtsInRegion: (regionId: string) => readonly string[];
}

const byRole: Readonly<Record<Role, string>> = {
  phc_staff: 'facility',
  district_officer: 'district',
  state_officer: 'state',
  national: 'country',
  auditor: 'audit',
};

export const scopeLevelOf = (role: Role): string => byRole[role];

/** Whether a session may submit an observation for a facility. */
export function canSubmitForFacility(
  session: Session,
  facilityId: string,
  scope: ScopeLookup,
): boolean {
  switch (session.role) {
    case 'phc_staff':
      // Only its own facility: this is the rule that keeps a capture form from
      // becoming a way to write another facility's ledger.
      return session.scopeId === facilityId;
    case 'district_officer': {
      const districtId = scope.districtOfFacility(facilityId);
      return districtId !== null && districtId === session.scopeId;
    }
    case 'state_officer': {
      const districtId = scope.districtOfFacility(facilityId);
      const regionId = districtId === null ? null : scope.regionOfDistrict(districtId);
      return regionId !== null && regionId === session.scopeId;
    }
    case 'national':
      return true;
    case 'auditor':
      return false;
  }
}

/** Whether a session may read a district's visibility. */
export function canReadDistrict(session: Session, districtId: string, scope: ScopeLookup): boolean {
  switch (session.role) {
    case 'phc_staff': {
      const own = session.scopeId === null ? null : scope.districtOfFacility(session.scopeId);
      return own !== null && own === districtId;
    }
    case 'district_officer':
      return session.scopeId === districtId;
    case 'state_officer': {
      const regionId = scope.regionOfDistrict(districtId);
      return regionId !== null && regionId === session.scopeId;
    }
    case 'national':
    case 'auditor':
      return true;
  }
}

/**
 * Whether a session may read the audit chain.
 *
 * The same rule the stored rules enforce on the collection
 * (`infra/firestore.rules`), restated here so the interface refuses the read
 * before it makes it: the auditor and the control room, and nobody else. A
 * district officer reading the chain would read every other district's decisions
 * in it, because a decision is a line in one shared record — so the refusal is a
 * tenancy rule rather than a matter of taste.
 */
export const canReadAuditChain = (session: Session): boolean =>
  session.role === 'auditor' || session.role === 'national';

/** Why a session may not act, in a sentence a client can show a user. */
export const scopeRefusalFor = (session: Session, level: string): string =>
  session.role === 'auditor'
    ? 'an auditor reads the record but does not write to it'
    : `${session.label} is scoped to a ${byRole[session.role]}, and this ${level} is outside it`;

/**
 * The district a session should open on.
 *
 * A scoped reader opens where its scope is rather than being shown a default it
 * may not read: a district officer who lands on the control room's opening
 * district and is then refused would reasonably read that as the platform being
 * broken. The fallback is the caller's default, used by the roles that read the
 * country and have no place of their own.
 */
export function openingDistrictFor(session: Session, scope: ScopeLookup, fallback: string): string {
  switch (session.role) {
    case 'phc_staff':
      return (
        (session.scopeId === null ? null : scope.districtOfFacility(session.scopeId)) ?? fallback
      );
    case 'district_officer':
      return session.scopeId ?? fallback;
    case 'state_officer': {
      const first =
        session.scopeId === null ? undefined : scope.districtsInRegion(session.scopeId)[0];
      return first ?? fallback;
    }
    case 'national':
    case 'auditor':
      return fallback;
  }
}

/**
 * Read a session out of a cookie value.
 *
 * Malformed input is a session that does not exist rather than an error, and the
 * fallback is the national read-only view: a request with a corrupted cookie
 * must not be refused service, and it must not be handed a wider scope than the
 * default either.
 */
export function parseSession(raw: string | undefined): Session {
  if (raw === undefined || raw.trim() === '') {
    return NATIONAL_SESSION;
  }

  try {
    const parsed = sessionSchema.safeParse(JSON.parse(decodeURIComponent(raw)));
    return parsed.success ? parsed.data : NATIONAL_SESSION;
  } catch {
    return NATIONAL_SESSION;
  }
}

/** The cookie value for a session. */
export const encodeSession = (session: Session): string =>
  encodeURIComponent(JSON.stringify(session));
