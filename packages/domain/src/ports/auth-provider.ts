import { z } from 'zod';

/**
 * Roles the platform recognises.
 *
 * Declared once, here, and inferred into a TypeScript union so that a role can
 * never be spelled differently in two places.
 */
export const ROLES = [
  'phc_staff',
  'district_officer',
  'state_officer',
  'national',
  'auditor',
] as const;

export const roleSchema = z.enum(ROLES);

export type Role = z.infer<typeof roleSchema>;

/**
 * The administrative scope a principal may act within.
 *
 * A district officer is confined to one district; a state officer to one state.
 * Tenancy is enforced from this object, never from a value supplied by a
 * client.
 */
export interface PrincipalScope {
  readonly stateId?: string;
  readonly districtId?: string;
  readonly facilityId?: string;
}

/** An authenticated actor. */
export interface Principal {
  readonly uid: string;
  readonly displayName: string;
  readonly role: Role;
  readonly scope: PrincipalScope;
}

/** Credentials presented to sign in. */
export interface Credentials {
  readonly email: string;
  readonly password: string;
}

/**
 * The authentication boundary.
 *
 * Implementations resolve an identity and the scope attached to it. No caller
 * receives a principal it did not obtain through this port, so swapping the
 * local fixture for a real identity provider changes nothing downstream.
 */
export interface AuthProvider {
  /** Stable identifier of the concrete adapter, reported by the health check. */
  readonly kind: string;
  currentPrincipal(): Promise<Principal | null>;
  signIn(credentials: Credentials): Promise<Principal>;
  signOut(): Promise<void>;
}
